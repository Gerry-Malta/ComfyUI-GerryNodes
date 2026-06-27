class GSSmartSwitch:
    """
    A boolean switch (like ComfyUI's native Switch) with one extra trick:
    it automatically traces every upstream node feeding *exclusively* into
    whichever branch is currently inactive, and grays out all of that
    node's widgets in place - so a dead calculation path doesn't leave
    editable-but-inert fields lying around to confuse people. If any of
    those widgets are promoted to an outer subgraph face, the promoted
    parameter disappears from that outer view entirely while the interior
    widget stays visible-but-grayed.

    Nodes that feed *both* branches (shared ancestors) are left alone, since
    they're still needed regardless of which side is active. All of the
    tracing and widget gray-out logic lives client-side in
    web/js/gs_smart_switch.js - this backend class only needs to actually
    pick a value at execution time.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "True routes on_true through and grays out on_false's exclusive upstream widgets. False does the reverse.",
                }),
                "auto_disable": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Turn off to disable the auto gray-out behavior entirely - the switch still routes on_true/on_false normally either way.",
                }),
            },
            "optional": {
                "on_true": ("*", {}),
                "on_false": ("*", {}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("output",)
    FUNCTION = "execute"
    CATEGORY = "utils/conditional"
    DESCRIPTION = "Switch between on_true/on_false based on a boolean, and automatically gray out widgets on any node used exclusively by the inactive branch."

    def execute(self, boolean, auto_disable, on_true=None, on_false=None):
        return (on_true if boolean else on_false,)


NODE_CLASS_MAPPINGS = {
    "GS_SmartSwitch": GSSmartSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GS_SmartSwitch": "GS SmartSwitch",
}
