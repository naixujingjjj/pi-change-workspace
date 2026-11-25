// Test fixture: veto session replacement, the way another extension can.
export default function vetoExtension(pi) {
  pi.on("session_before_switch", () => {
    if (process.env.PI_WORKSPACE_VETO === "1") return { cancel: true };
    return undefined;
  });
}