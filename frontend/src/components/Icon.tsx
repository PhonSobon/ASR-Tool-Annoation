import { ICON_SYMBOLS, type IconName } from "./icon-sprite";

/** An icon from the sprite. Decorative: the button text or its aria-label says what it does. */
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`i ${className}`} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The sprite itself, once per page (root layout). */
export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"
         focusable="false" dangerouslySetInnerHTML={{ __html: ICON_SYMBOLS }} />
  );
}
