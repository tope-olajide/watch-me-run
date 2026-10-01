import { setMarkerEnabled, useMarkerEnabled } from "./marker";

/**
 * The best-line mark's switch: one control, in the menu and in the pause overlay.
 *
 * It is one component rather than two controls that agree by convention, for the same reason the
 * sound panel is: the menu is where a player decides how a run should look before starting one, and
 * the pause overlay is where they decide it the moment the road starts carrying a mark they did not
 * ask for. Off is a real state and says so — a switch that only ever shows the state a player is not
 * in is a switch nobody can read.
 *
 * The full variant carries the explanation; the menu's variant is one row in the top bar, because a
 * control that has to be scrolled to is not a control.
 */
export default function MarkerSettings({ compact = false }: { compact?: boolean }) {
  const on = useMarkerEnabled();
  const toggle = (
    <button
      className="marker-toggle"
      type="button"
      aria-pressed={on}
      title={
        on
          ? "Hide the mark on the road where your best run held its lane"
          : "Show where your best run held its lane, at the metre you are at now"
      }
      onClick={() => setMarkerEnabled(!on)}
    >
      {on ? "On" : "Off"}
    </button>
  );

  if (compact) {
    return (
      <div className="marker-settings marker-compact" data-on={on ? "true" : "false"}>
        <span className="marker-dot" />
        <span className="marker-label">Best-line mark</span>
        {toggle}
      </div>
    );
  }

  return (
    <div className="marker-settings" data-on={on ? "true" : "false"}>
      <div className="marker-heading">
        <span className="eyebrow">Best-line mark</span>
        {toggle}
      </div>
      <p className="marker-hint">
        The ring and the light on the road where your best run held its lane, at the metre you are at
        now. Off by default — the ghost is help a player asks for.
      </p>
    </div>
  );
}
