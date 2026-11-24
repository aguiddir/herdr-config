// A button that folds and reopens one node of the layout: props { target: <node id>, label }.
// Personal mod (not from the harnais): it sits in the gutter of layouts/mine.json, so it stays
// in view while its target is folded.
import { View, div } from "gpui-kit";
import { layout, run, theme, props } from "herdr";

const find = (node, id) => !node ? null : node.id === id ? node
  : [...(node.children ?? []), ...(node.floating ?? [])].map((c) => find(c, id)).find(Boolean) ?? null;

export default class PanelToggle extends View {
  render() {
    const t = theme(), { target = "pr-agents", label = "PR" } = props() ?? {};
    // A missing target (typo, block removed) shows a dead button instead of one that errors on click.
    const node = find(layout(), target), open = !!node && !node.hidden;
    const tip = !node ? `${target} absent du layout` : open ? `Replier ${label}` : `Ouvrir ${label}`;
    const button = div().id("toggle").h(26).px(8).flex().items_center().rounded(6).text_size(12)
      .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted)
      .tooltip(tip).accessibility_label(tip).child(label);
    return div().size_full().flex().justify_center().child(!node ? button
      : button.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("layout.toggle", { id: target })));
  }
}
