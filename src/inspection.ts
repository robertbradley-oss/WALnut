import { useEffect, useState } from "react";
import type { Snapshot, WalFrame } from "./types";

/** A log selection belongs to one displayed operation, never another run. */
export function useLogSelection(snapshot: Snapshot | null, scope: string) {
  const [selection, setSelection] = useState<{
    scope: string;
    generation: number;
  }>();
  useEffect(() => setSelection(undefined), [scope]);
  const frame =
    selection?.scope === scope
      ? snapshot?.wal_frames.find(
          (frame) => frame.generation === selection.generation,
        )
      : undefined;
  return {
    frame,
    selectFrame: (frame?: WalFrame) =>
      setSelection(frame ? { scope, generation: frame.generation } : undefined),
  };
}

export function operationId(snapshot: Snapshot) {
  return `${snapshot.database_id}:${snapshot.session_id}:${snapshot.events.at(-1)?.operation ?? "idle"}`;
}
