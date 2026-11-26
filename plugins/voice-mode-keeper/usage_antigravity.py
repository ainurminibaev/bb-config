"""Let the catalog Usage screen show Antigravity quotas from BB's shared account source.

Thread Account Usage reads both Antigravity CLI accounts on their machine:
Google Antigravity (quota per model group) and Antig (prepaid hours). Usage
only lists Claude and Codex limits, so its rows for these come from the same
`accounts` RPC. Added after the VClaude rows, before the same anchor.
"""
from tokenomics_compat import AnchorMismatch

ANCHOR = '  return machineRows.flat();\n}\n\nexport async function loadCodexResetCredits'
MARKER = 'const antigravityAccounts = await bb.sdk.plugins.callRpc'
ADDITION = '''  try {
    const antigravityAccounts = await bb.sdk.plugins.callRpc({
      pluginId: "thread-account-usage",
      method: "accounts",
      input: { refresh: false },
      outputSchema: z.object({ accounts: z.array(z.object({
        providerId: z.string(), providerName: z.string(), hostIds: z.array(z.string()), hostNames: z.array(z.string()),
        email: z.string().nullable(), plan: z.string().nullable(), status: z.string(), message: z.string().nullable(),
        fetchedAt: z.string().nullable(),
        windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable(),
          endsAt: z.string().nullable().optional() }).passthrough()),
      }).passthrough()) }).passthrough(),
      signal: AbortSignal.timeout(8_000),
    });
    for (const account of antigravityAccounts.accounts) {
      if (account.providerId !== "acp-antigravity-acp" && account.providerId !== "acp-gemini-antig") continue;
      machineRows.push([{
        machineId: account.hostIds[0] ?? account.providerId, machineName: account.hostNames.join(", ") || account.providerName,
        agentId: account.providerId, agentName: account.providerName, providerId: account.providerId, providerName: account.providerName,
        accountEmail: account.email, accountIdentity: `${account.providerId}:${account.email ?? ""}`, planLabel: account.plan,
        lastUpdatedAt: account.fetchedAt,
        status: account.status === "ok" ? "ok" : "error", error: account.status === "ok" ? null : account.message,
        windows: account.windows.map((w) => ({
          label: w.endsAt && Number.isFinite(Date.parse(w.endsAt))
            ? `${w.label} до ${new Date(w.endsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}` : w.label,
          usedPercent: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: w.resetsAt,
        })),
      }]);
    }
  } catch {
    // The shared account plugin is optional on installations of Usage.
  }
'''


def rewrite(source: bytes, _version: str) -> bytes:
    text = source.decode()
    newline = '\r\n' if '\r\n' in text else '\n'
    normalized = text.replace('\r\n', '\n')
    if normalized.count(MARKER) == 1:
        return source
    if MARKER in normalized or normalized.count(ANCHOR) != 1:
        raise AnchorMismatch('Usage: не найдено однозначное место подключения квот Antigravity.')
    return normalized.replace(ANCHOR, ADDITION + ANCHOR).replace('\n', newline).encode()
