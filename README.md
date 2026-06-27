# ComfyUI GerryNodes

<p align="center">
  <img src="https://github.com/user-attachments/assets/008609cc-33b4-40ee-b8bf-995decb19831" width="48" height="48" alt="ComfyUI">
  <img src="https://github.com/user-attachments/assets/3baaab14-4ea5-490f-98e4-4f825073b6c5" width="48" height="48" alt="Claude">
  <img src="https://github.com/user-attachments/assets/fc7de6d0-1ceb-4857-8836-13dd2e31b23d" width="48" height="48" alt="NanoBanana">
  <img src="https://github.com/user-attachments/assets/060de070-8128-4da5-8540-606eb8278507" width="48" height="48" alt="Ollama">
  <img src="https://github.com/user-attachments/assets/609d3dbc-9a05-4317-8019-6103f7868027" width="48" height="48" alt="District Zero">
</p>

## GS SmartSwitch

A drop-in replacement for ComfyUI's native `Switch`, with one extra trick:
it traces every node feeding **exclusively** into whichever branch (`on_true`
or `on_false`) is not currently active, and grays out all of that node's
widgets in place - so a dead calculation path doesn't leave editable-but-
inert fields sitting around to confuse people.


<img width="2693" height="1409" alt="Capture2" src="https://github.com/user-attachments/assets/9ba2fe0b-dc56-484d-8aeb-44a40970891b" />
<img width="2622" height="1251" alt="Capture1" src="https://github.com/user-attachments/assets/2c15c833-7f85-4504-bee0-f8468ec71dd6" />


It works the same way whether the nodes involved live in the main graph or
inside a subgraph. If a grayed-out widget happens to be promoted to a
subgraph's outer face, the promoted parameter disappears from that outer
view entirely - so a packaged subgraph stays tidy and only shows the
parameters that are actually relevant to its current state, instead of
exposing irrelevant fields from whichever branch isn't in use.

Nodes that feed **both** branches (shared ancestors - e.g. a width/height
primitive both methods depend on) are left untouched, since they're still
needed regardless of which side is active.

## Install

Drop this folder into `ComfyUI/custom_nodes/`, then restart ComfyUI:

```
ComfyUI/custom_nodes/ComfyUI-GerryNodes/
├── __init__.py
├── nodes.py
├── pyproject.toml
└── web/
    └── js/
        └── gs_smart_switch.js
```

No Python dependencies. Lives under **utils/conditional** in the node
search, as **GS SmartSwitch**.

## Usage

1. Wire your two candidate calculation paths into `on_true` and `on_false`.
2. Flip the `boolean` widget - whichever branch is active stays fully
   visible; every node used *only* by the other branch grays out
   automatically.
3. The switch's `output` passes through whichever branch is selected, same
   as the native Switch node.
4. Toggle `auto_disable` off if you want to temporarily turn the gray-out
   behavior off entirely without rewiring anything - the switch still
   routes normally either way.

No target titles, no widget names, no manual setup - it figures out what's
relevant on its own by walking the graph.

## How it decides what to gray out

Every tick (~200ms), it:
1. Walks upstream from `on_true`'s source, collecting every ancestor node
   (following input links backwards, recursively, no special-casing for
   reroutes or anything else).
2. Does the same for `on_false`.
3. Subtracts the two sets from each other - what's left for each side is
   that branch's *exclusive* ancestry.
4. Grays every widget on every node in the inactive branch's exclusive set;
   restores every widget on every node in the active branch's exclusive set.

If more than one SmartSwitch in the graph claims the same node, it only
goes back to active once *every* claiming switch has released it - so two
switches sharing an ancestor can't fight over the same widget's state.

## Limitations

- Detection is structural (which nodes are reachable), not semantic - if a
  node happens to feed both branches even though conceptually it "belongs"
  to one, it'll be left visible on both, which is the safe failure mode.
- This only affects widget appearance - it doesn't bypass/mute execution.
  The inactive branch's nodes still run if something downstream forces a
  queue. Pair with a bypass/mute-on-boolean node (e.g. from
  `ComfyUI-vslinx-nodes`) if you also want it to stop computing, not just
  stop being visible.
- Polling-based (200ms): trivial CPU cost, slight latency, but robust
  across every load path (fresh drop, loaded workflow, undo/redo,
  copy-paste) rather than depending on a particular node lifecycle hook
  firing.
- If a widget had a *custom* display label set before ever going inactive,
  and all in-memory tracking is lost (e.g. across a page reload, before
  this extension ever touched it in the new session), restoring it falls
  back to its default name rather than recovering that custom label - a
  minor cosmetic edge case.
- Nodes already placed on a canvas before a display-name change keep their
  own frozen title - only newly-created instances pick up a renamed
  display name automatically.