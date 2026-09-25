// Tools denied for every principal, including tools:'all'. These mutate
// desktop-commander's own guardrails (blocklist, allowedDirectories) or phone home;
// remote mutation of them is a privilege-escalation path. Config changes require a
// local file edit.
export const DENY_REMOTE = new Set([
  'set_config_value',
  'give_feedback_to_desktop_commander',
]);

// Returns shared cross-client history (arguments and outputs of other sessions).
// Granted only when a principal explicitly opts in via allowSharedHistory.
export const SHARED_HISTORY_TOOLS = new Set(['get_recent_tool_calls']);

export interface Grantable {
  tools: string[] | 'all';
  allowSharedHistory: boolean;
}

// Resolves a principal's grants against the inventory of the pinned upstream binary.
// 'all' means the inventory minus DENY_REMOTE — never a superset, so a dependency
// update adding a new tool does not silently widen remote privileges.
export function grantedToolNames(principal: Grantable, inventory: string[]): Set<string> {
  const requested = principal.tools === 'all' ? inventory : principal.tools;
  const granted = new Set<string>();
  for (const name of requested) {
    if (DENY_REMOTE.has(name)) continue;
    if (!principal.allowSharedHistory && SHARED_HISTORY_TOOLS.has(name)) continue;
    if (inventory.includes(name)) granted.add(name);
  }
  return granted;
}

// Configured names that do not exist in the pinned binary's tools/list. Callers
// fail loudly on these rather than silently granting nothing.
export function unknownGrantNames(tools: string[] | 'all', inventory: string[]): string[] {
  if (tools === 'all') return [];
  return tools.filter((t) => !inventory.includes(t));
}
