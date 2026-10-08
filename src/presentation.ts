import type { Plan } from "./types.js";

const status = (done: boolean): string => (done ? "done" : "open");

/** Show the changes a person needs to review before applying the plan. */
export function renderPlan(plan: Plan, applied: boolean): string {
  const lines = [
    `${applied ? "Applied" : "Preview"} · ${plan.target} · ${plan.direction}`,
  ];
  for (const action of plan.actions) {
    const reference = action.type === "create" ? "" : ` → ${action.issue.id}`;
    lines.push(`  ${action.type.padEnd(7)} ${action.key}${reference}`);
    switch (action.type) {
      case "create":
        lines.push(
          `    title: ${JSON.stringify(action.content.title)}`,
          `    completion: ${status(action.done)}`,
        );
        break;
      case "update":
        if (action.patch.done !== undefined)
          lines.push(
            `    completion: ${status(action.issue.done)} → ${status(action.patch.done)}`,
          );
        if (action.patch.title !== undefined)
          lines.push(
            `    title: ${JSON.stringify(action.issue.title)} → ${JSON.stringify(action.patch.title)}`,
          );
        if (action.patch.description !== undefined)
          lines.push("    managed description: updated");
        break;
      case "pull":
        lines.push(`    local checkbox: ${action.done ? "[x]" : "[ ]"}`);
        break;
      case "adopt":
        lines.push("    record issue mapping and sync baseline");
        break;
    }
  }
  for (const conflict of plan.conflicts)
    lines.push(`  conflict ${conflict.key}: ${conflict.reason}`);
  for (const key of plan.orphaned)
    lines.push(`  orphan   ${key} (remote issue retained)`);
  lines.push(
    `${plan.actions.length} actions · ${plan.unchanged} unchanged · ${plan.conflicts.length} conflicts`,
  );
  if (!applied && plan.conflicts.length)
    lines.push("Batch blocked. Resolve the conflicts and preview again.");
  else if (!applied && plan.actions.length)
    lines.push("Run sync with --apply to save these changes.");
  return lines.join("\n") + "\n";
}
