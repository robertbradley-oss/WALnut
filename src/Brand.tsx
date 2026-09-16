import lockup from "../public/brand/walnut-lockup-dark.svg?raw";
import mark from "../public/brand/walnut-mark.svg?raw";

const svgSource = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;

// Embedded sources also work in the self-contained, offline replay.
export const brandMark = svgSource(mark);
const brandLockup = svgSource(lockup);

export function Brand({ href, label }: { href: string; label: string }) {
  return (
    <a className="lab-brand" href={href} aria-label={label}>
      <img
        className="brand-lockup"
        src={brandLockup}
        width="690"
        height="160"
        alt=""
      />
      <img
        className="brand-mark"
        src={brandMark}
        width="256"
        height="256"
        alt=""
      />
    </a>
  );
}
