use std::collections::BTreeMap;
use walnut_core::{MAX_PAGES, Meta, Node, PAGE_SIZE, Tree, WriteOp, page::Contents};
fn key(i: usize) -> String {
    format!("item/{i:05}/{}", "k".repeat(53))
}
fn writes(start: usize, count: usize) -> Vec<WriteOp> {
    (start..start + count)
        .map(|i| WriteOp {
            key: key(i),
            value: format!("{i:04}{}", "v".repeat(996)),
        })
        .collect()
}
fn seed(count: usize) -> Tree {
    Tree::from_entries(writes(0, count).into_iter().map(|w| (w.key, w.value)), 1).unwrap()
}
fn all(tree: &Tree) -> Vec<(String, String)> {
    let mut start = String::new();
    let mut records = vec![];
    loop {
        let r = tree.range(&start, None, 17).unwrap();
        records.extend(r.records.into_iter().map(|r| (r.key, r.value)));
        if let Some(next) = r.next_key {
            start = next;
        } else {
            break;
        }
    }
    records
}

#[test]
fn physical_capacity_splits_leaves_and_cascades_into_a_new_root() {
    let leaf = seed(3);
    assert_eq!(leaf.meta.height, 1);
    assert_eq!(key(0).len(), 64);
    let first = leaf.with_batch(&writes(3, 2)).unwrap();
    assert_eq!(first.tree.meta.records, 5);
    assert_eq!(first.tree.meta.height, 2);
    assert_eq!(first.tree.pages.len(), 3);
    assert_eq!(
        first.changed.iter().copied().collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    let base = seed(116);
    assert_eq!(base.meta.height, 2);
    assert_eq!(base.pages.len(), 59);
    let next = base.with_batch(&writes(116, 2)).unwrap();
    assert_eq!(next.tree.meta.height, 3);
    assert_eq!(next.tree.pages.len(), 62);
    assert_eq!(next.tree.meta.records, 118);
    assert!(next.events.iter().any(|e| e.kind == "internal_split"));
    assert!(next.events.iter().any(|e| e.kind == "root_changed"));
    for w in writes(0, 118) {
        let (value, path) = next.tree.get(&w.key).unwrap();
        assert_eq!(value, Some(w.value));
        assert_eq!(path.len(), 3);
    }
    assert_eq!(next.tree.meta.generation, 2);
    next.tree.validate().unwrap();
}

#[test]
fn value_growth_can_split_without_changing_record_count_and_duplicates_use_last_value() {
    let base = Tree::from_entries((0..4).map(|i| (key(i), String::new())), 1).unwrap();
    let next = base.with_batch(&writes(0, 4)).unwrap();
    assert_eq!(next.tree.meta.records, 4);
    assert_eq!(next.tree.meta.height, 2);
    let w = vec![
        WriteOp {
            key: "é".into(),
            value: "first".into(),
        },
        WriteOp {
            key: "é".into(),
            value: "🌰\0\n".into(),
        },
        WriteOp {
            key: "empty".into(),
            value: "".into(),
        },
    ];
    let last = next.tree.with_batch(&w).unwrap().tree;
    assert_eq!(last.get("é").unwrap().0.as_deref(), Some("🌰\0\n"));
    assert_eq!(last.get("empty").unwrap().0.as_deref(), Some(""));
    assert_eq!(last.meta.generation, 3);
    assert_eq!(last.meta.records, 6);
}

#[test]
fn ranges_follow_leaf_links_with_inclusive_start_exclusive_end_and_cursor() {
    let tree = seed(130);
    let range = tree.range(&key(7), Some(&key(82)), 9).unwrap();
    assert_eq!(range.records.len(), 9);
    assert_eq!(range.records[0].key, key(7));
    assert_eq!(range.next_key, Some(key(16)));
    let mut out = vec![];
    let mut start = key(7);
    loop {
        let r = tree.range(&start, Some(&key(82)), 9).unwrap();
        out.extend(r.records.into_iter().map(|r| r.key));
        if let Some(next) = r.next_key {
            start = next;
        } else {
            break;
        }
    }
    assert_eq!(out, (7..82).map(key).collect::<Vec<_>>());
    assert!(
        tree.range(&key(10), Some(&key(10)), 10)
            .unwrap()
            .records
            .is_empty()
    );
    assert!(tree.range("z", None, 1).unwrap().records.is_empty());
    for (start, end, limit) in [("z", Some("a"), 1), ("", None, 0), ("", None, 257)] {
        assert_eq!(
            tree.range(start, end, limit).unwrap_err().code,
            "invalid_range"
        );
    }
}

#[test]
fn generated_batches_and_updates_match_an_independent_ordered_map() {
    let mut tree = Tree::empty();
    let mut reference = BTreeMap::new();
    let mut random = 0x57414c6e7574u64;
    for batch in 0..90 {
        let mut ops = vec![];
        for i in 0..17 {
            random = random
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let key = if i % 8 == 0 {
                format!("é{:04}", (random >> 32) % 600)
            } else {
                format!("k{:04}", (random >> 32) % 600)
            };
            let value = format!(
                "{batch}:{i}:{}",
                "v".repeat(((random >> 40) % 990) as usize)
            );
            ops.push(WriteOp { key, value });
        }
        let next = tree.with_batch(&ops).unwrap();
        for w in ops {
            reference.insert(w.key, w.value);
        }
        tree = next.tree;
        assert_eq!(
            all(&tree),
            reference
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Vec<_>>()
        );
        for (key, value) in reference.iter().step_by(19) {
            assert_eq!(tree.get(key).unwrap().0.as_ref(), Some(value));
        }
        tree.validate().unwrap();
    }
    assert!(tree.meta.height >= 2);
}

#[test]
fn page_codec_round_trips_and_checks_every_byte_and_short_input() {
    let tree = seed(4);
    for node in tree.pages.values() {
        let bytes = node.encode().unwrap();
        assert_eq!(Node::decode(&bytes).unwrap(), *node);
        for cut in 0..PAGE_SIZE {
            assert!(Node::decode(&bytes[..cut]).is_err());
        }
        for i in 0..PAGE_SIZE {
            let mut bad = bytes;
            bad[i] ^= 1;
            assert!(Node::decode(&bad).is_err());
        }
    }
    let meta = tree.meta.encode().unwrap();
    assert_eq!(Meta::decode(&meta).unwrap(), tree.meta);
    for i in 0..PAGE_SIZE {
        let mut bad = meta;
        bad[i] ^= 1;
        assert!(Meta::decode(&bad).is_err());
    }
}

#[test]
fn structural_validation_rejects_broken_routing_allocation_depth_and_links() {
    let tree = seed(10);
    let mut bad = tree.clone();
    bad.meta.records += 1;
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    if let Contents::Internal { keys, .. } =
        &mut bad.pages.get_mut(&bad.meta.root).unwrap().contents
    {
        keys[0] = "item/00001/incorrect".into();
    }
    bad.seal().unwrap();
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    if let Contents::Internal { children, .. } =
        &mut bad.pages.get_mut(&bad.meta.root).unwrap().contents
    {
        children[0] = bad.meta.root;
    }
    bad.seal().unwrap();
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    if let Contents::Leaf { next, .. } = &mut bad.pages.get_mut(&1).unwrap().contents {
        *next = 1;
    }
    bad.seal().unwrap();
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    let id = bad.meta.next_id;
    bad.pages.insert(id, Node::leaf(id, 1));
    bad.meta.next_id += 1;
    bad.seal().unwrap();
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    bad.meta.height += 1;
    assert!(bad.validate().is_err());
    let mut bad = tree.clone();
    bad.pages.get_mut(&1).unwrap().generation += 1;
    bad.seal().unwrap();
    assert!(bad.validate().is_err());
}

#[test]
fn bounds_and_allocation_exhaustion_leave_the_original_tree_unchanged() {
    let mut tree = Tree::empty();
    let mut start = 0;
    loop {
        let before = tree.clone();
        match tree.with_batch(&writes(start, 64)) {
            Ok(next) => {
                tree = next.tree;
                start += 64;
            }
            Err(e) => {
                assert_eq!(e.code, "database_full");
                assert_eq!(tree, before);
                break;
            }
        }
        assert!(start < MAX_PAGES as usize * 4);
    }
    assert!(tree.pages.len() > MAX_PAGES as usize - 100);
    tree.validate().unwrap();
    for w in [
        WriteOp {
            key: "".into(),
            value: "x".into(),
        },
        WriteOp {
            key: "é".repeat(33),
            value: "x".into(),
        },
        WriteOp {
            key: "ok".into(),
            value: "x".repeat(1025),
        },
    ] {
        assert!(tree.with_batch(&[w]).is_err());
    }
}
