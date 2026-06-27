import { app } from "../../../scripts/app.js";

const POLL_INTERVAL_MS = 200;
const NODE_TYPE = "GS_SmartSwitch";
const LABEL_SUFFIX = " (GS SmartSwitch)";

/**
 * Walks a graph (and any nested subgraphs) collecting every node, so the
 * watcher finds SmartSwitch instances regardless of nesting depth.
 */
function collectAllNodes(rootGraph, seen = new Set(), out = []) {
  if (!rootGraph || !rootGraph._nodes) return out;
  for (const n of rootGraph._nodes) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (n.subgraph && n.subgraph._nodes) {
      collectAllNodes(n.subgraph, seen, out);
    }
  }
  return out;
}

/**
 * Recursively walks upstream from `startNode`, following every input link
 * backwards, collecting every ancestor node reachable that way. Naturally
 * terminates at nodes with no further input links (primitives, loaders).
 * Reroutes and any other pass-through node type are walked the same as
 * everything else - no special-casing needed.
 */
function collectAncestors(startNode, seen) {
  if (!startNode || !startNode.inputs) return seen;
  const graph = startNode.graph;
  if (!graph) return seen;

  for (const input of startNode.inputs) {
    if (input.link == null) continue;
    const link = graph.links[input.link];
    if (!link) continue;
    const originNode = graph.getNodeById(link.origin_id);
    if (!originNode || seen.has(originNode)) continue;
    seen.add(originNode);
    collectAncestors(originNode, seen);
  }
  return seen;
}

function originOf(graph, inputSlot) {
  if (!inputSlot || inputSlot.link == null) return null;
  const link = graph.links[inputSlot.link];
  if (!link) return null;
  return graph.getNodeById(link.origin_id);
}

/**
 * Strips any previously-appended suffix back off a label string, so it
 * never accidentally stacks twice or loses track of the real original text.
 */
function stripSuffix(label) {
  if (typeof label !== "string") return label;
  if (label.endsWith(LABEL_SUFFIX)) {
    return label.slice(0, -LABEL_SUFFIX.length);
  }
  return label;
}

function setWidgetActive(widget) {
  const looksInactive = widget.disabled === true || widget.hidden === true || (typeof widget.label === "string" && widget.label.endsWith(LABEL_SUFFIX));
  if (!looksInactive) return false; // already looks active, nothing to do

  widget.disabled = false;
  widget.hidden = false;
  if (widget._gs_hadOrigLabel) {
    widget.label = widget._gs_origLabel;
  } else {
    delete widget.label;
  }
  delete widget._gs_hadOrigLabel;
  delete widget._gs_origLabel;
  return true;
}

function setWidgetInactive(widget) {
  if (widget._gs_hadOrigLabel === undefined) {
    widget._gs_hadOrigLabel = Object.prototype.hasOwnProperty.call(widget, "label");
    widget._gs_origLabel = widget.label;
  }

  const base = stripSuffix(widget.label || widget.name || "");
  const newLabel = `${base}${LABEL_SUFFIX}`;
  const changed = widget.disabled !== true || widget.hidden !== true || widget.label !== newLabel;

  widget.disabled = true;
  widget.label = newLabel;
  // .hidden alone (without collapsing computeSize/layout) is what makes a
  // promoted parameter disappear from the subgraph's outer face, while the
  // interior widget stays visible-but-grayed - confirmed by direct testing.
  // ComfyUI's own subgraph-promotion logic appears to treat .hidden as "this
  // widget no longer meaningfully exists," so it removes the promoted copy
  // accordingly, even though it leaves cosmetic-only changes (disabled,
  // label) alone.
  widget.hidden = true;
  return changed;
}

/**
 * Given the graph a node lives in, finds the node (anywhere in the graph
 * tree, searched from searchRoot) whose .subgraph property IS that graph -
 * i.e. the collapsed "host" node representing this subgraph one level up.
 * Returns null at the top level, where no such host exists.
 */
function findSubgraphHostNode(targetGraph, searchRoot) {
  if (!targetGraph) return null;
  const seen = new Set();
  function walk(g) {
    if (!g || !g._nodes) return null;
    for (const n of g._nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (n.subgraph === targetGraph) return n;
      if (n.subgraph) {
        const found = walk(n.subgraph);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(searchRoot);
}

function applyNodeActive(node, active) {
  if (!node.widgets || !node.widgets.length) return;
  let changed = false;
  for (const widget of node.widgets) {
    const didChange = active ? setWidgetActive(widget) : setWidgetInactive(widget);
    if (didChange) changed = true;
  }
  if (changed) {
    // Swap the widgets array for a shallow copy of itself - same objects,
    // same order, nothing removed or repositioned, but the array reference
    // changes. This was added while chasing a live-update issue that .hidden
    // (above) turned out to actually fix - it's kept here because it was
    // part of the combination confirmed working, but it may be unnecessary
    // on its own. Worth testing removal in isolation if you want to slim
    // this down further; not removed now to avoid risking a regression
    // right after getting this working.
    node.widgets = [...node.widgets];
    node.setDirtyCanvas(true, true);

    // Same reasoning for the subgraph's outer "host" node, if this node
    // lives inside one. Note: per ComfyUI's own docs, a promoted widget is
    // a *copy*, not a shared reference to the interior widget - so this
    // reassignment doesn't pull in any new state from the interior on its
    // own. The actual fix for the promoted view disappearing is .hidden
    // above; this is most likely a no-op kept defensively for the same
    // reason as the interior reassignment.
    try {
      const hostNode = findSubgraphHostNode(node.graph, app.graph);
      if (hostNode?.widgets) {
        hostNode.widgets = [...hostNode.widgets];
        hostNode.setDirtyCanvas(true, true);
      }
    } catch (e) {
      // best-effort only
    }

    try {
      app.canvas?.setDirty(true, true);
    } catch (e) {
      // not fatal if this particular call isn't available
    }
  }
}

// Global claim tracking: a node should only be marked active again once
// EVERY switch that was claiming it inactive has released that claim. This
// matters whenever a node is reachable from more than one SmartSwitch+ in
// the graph - without it, two switches can fight over the same widget.
const _inactiveClaims = new Map(); // node -> Set<switchNode>
const _switchState = new Map(); // switchNode -> { claimedInactive: Set<node> }

function setClaim(node, switchNode, claimInactive) {
  let claimers = _inactiveClaims.get(node);

  if (claimInactive) {
    if (!claimers) {
      claimers = new Set();
      _inactiveClaims.set(node, claimers);
    }
    claimers.add(switchNode);
  } else if (claimers) {
    claimers.delete(switchNode);
    if (claimers.size === 0) {
      _inactiveClaims.delete(node);
      claimers = null;
    }
  }

  const shouldBeInactive = !!(claimers && claimers.size > 0);
  try {
    applyNodeActive(node, !shouldBeInactive);
  } catch (e) {
    // node may have been deleted from the graph entirely - nothing to apply
  }
}

function releaseAllClaims(switchNode) {
  const state = _switchState.get(switchNode);
  if (!state) return;
  for (const n of state.claimedInactive) {
    setClaim(n, switchNode, false);
  }
  _switchState.delete(switchNode);
}

function processSwitch(switchNode) {
  const boolWidget = switchNode.widgets?.find((w) => w.name === "boolean");
  const enabledWidget = switchNode.widgets?.find((w) => w.name === "auto_disable");
  if (!boolWidget) return;

  const boolValue = !!boolWidget.value;
  // Default to enabled if the widget isn't found, for safety with any
  // older saved workflow that predates it existing.
  const autoDisable = enabledWidget ? !!enabledWidget.value : true;

  const graph = switchNode.graph;
  if (!graph) return;

  const trueInput = switchNode.inputs?.find((i) => i.name === "on_true");
  const falseInput = switchNode.inputs?.find((i) => i.name === "on_false");

  const trueOrigin = originOf(graph, trueInput);
  const falseOrigin = originOf(graph, falseInput);

  const trueAncestors = trueOrigin ? collectAncestors(trueOrigin, new Set([trueOrigin])) : new Set();
  const falseAncestors = falseOrigin ? collectAncestors(falseOrigin, new Set([falseOrigin])) : new Set();

  const exclusiveTrue = [...trueAncestors].filter((n) => !falseAncestors.has(n));
  const exclusiveFalse = [...falseAncestors].filter((n) => !trueAncestors.has(n));

  const newClaimedInactive = autoDisable
    ? new Set(boolValue ? exclusiveFalse : exclusiveTrue)
    : new Set();
  const currentActiveExclusive = autoDisable
    ? (boolValue ? exclusiveTrue : exclusiveFalse)
    : [...exclusiveTrue, ...exclusiveFalse];

  let state = _switchState.get(switchNode);
  if (!state) {
    state = { claimedInactive: new Set() };
    _switchState.set(switchNode, state);
  }

  // Release any node this switch was claiming inactive but no longer is
  // (covers disconnection, rewiring, or a flipped boolean).
  for (const n of state.claimedInactive) {
    if (!newClaimedInactive.has(n)) {
      setClaim(n, switchNode, false);
    }
  }

  // Proactively re-assert EVERY currently-relevant node's claim status on
  // every tick, rather than only reacting to changes since last tick - this
  // is what keeps stale state (e.g. left over from before a page reload,
  // which resets this in-memory tracking but not the widgets' own
  // properties) from getting stuck uncorrected.
  for (const n of newClaimedInactive) {
    setClaim(n, switchNode, true);
  }
  for (const n of currentActiveExclusive) {
    setClaim(n, switchNode, false);
  }

  state.claimedInactive = newClaimedInactive;
}

function startGlobalWatcher() {
  setInterval(() => {
    let allNodes;
    try {
      allNodes = collectAllNodes(app.graph);
    } catch (e) {
      console.error("[GSSmartSwitch] failed to walk graph tree:", e);
      return;
    }

    const liveSwitches = allNodes.filter((n) => n.type === NODE_TYPE);
    const liveSet = new Set(liveSwitches);

    // Clean up switches that no longer exist - release every claim they
    // were holding so nothing stays permanently inactive because of a
    // switch that was deleted.
    for (const switchNode of [..._switchState.keys()]) {
      if (!liveSet.has(switchNode)) {
        releaseAllClaims(switchNode);
      }
    }

    for (const sw of liveSwitches) {
      try {
        processSwitch(sw);
      } catch (e) {
        console.error("[GSSmartSwitch] error processing switch", sw?.id, e);
      }
    }
  }, POLL_INTERVAL_MS);
}

// District Zero branding badge, drawn in the node's top-right corner.
// Loaded once from the extension's own bundled web/img/ folder - resolved
// relative to this script's own URL so it works regardless of the
// extension's serving path, rather than hardcoding /extensions/... .
const BADGE_SRC = new URL("../img/district_zero.png", import.meta.url).href;
const BADGE_SIZE = 20;
const BADGE_MARGIN = 8;
const TITLE_HEIGHT = 30; // litegraph's standard default title bar height
const BADGE_LINK_URL = "https://thedistrictzero.com/";

const badgeImg = new Image();
let badgeReady = false;
badgeImg.onload = () => {
  badgeReady = true;
  try {
    app.canvas?.setDirty(true, true);
  } catch (e) {
    // not fatal if the canvas isn't ready yet at load time
  }
};
badgeImg.onerror = () => {
  console.warn("[GSSmartSwitch] District Zero badge failed to load from", BADGE_SRC);
};
badgeImg.src = BADGE_SRC;

/**
 * Single source of truth for the badge's position, in the same node-local
 * coordinate space onDrawForeground and onMouseDown both use - so drawing
 * and click hit-testing can never drift out of sync with each other.
 */
function getBadgeRect(node) {
  return {
    x: node.size[0] - BADGE_SIZE - BADGE_MARGIN,
    y: -TITLE_HEIGHT + (TITLE_HEIGHT - BADGE_SIZE) / 2,
    size: BADGE_SIZE,
  };
}

function isInsideBadge(node, pos) {
  if (!pos) return false;
  const { x, y, size } = getBadgeRect(node);
  const [px, py] = pos;
  return px >= x && px <= x + size && py >= y && py <= y + size;
}

app.registerExtension({
  name: "GS.SmartSwitch",
  async setup() {
    startGlobalWatcher();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDrawForeground?.apply(this, arguments);
      if (!badgeReady || this.flags?.collapsed) return;

      const { x, y, size } = getBadgeRect(this);
      ctx.drawImage(badgeImg, x, y, size, size);
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos, canvas) {
      if (badgeReady && !this.flags?.collapsed && BADGE_LINK_URL && isInsideBadge(this, pos)) {
        window.open(BADGE_LINK_URL, "_blank");
        return true; // handled - don't let litegraph start a node-drag from this click
      }
      return onMouseDown?.apply(this, arguments);
    };
  },
});

// Debug hook - lets us inspect real internal state live from DevTools
// console instead of guessing from JSON snapshots.
window.__gsSmartSwitchDebug = {
  collectAllNodes,
  collectAncestors,
  _inactiveClaims,
  _switchState,
  VERSION: "1.2.0-clickable-badge",
};
