# Configuration

[← README](../README.md) · [한국어 README](../README.ko.md)

## Runtime discovery

The package uses your installed official agent. `paseo-acp doctor` reports discovery results without starting a model conversation.

For Antigravity, make `agy` available on `PATH` or set `AGY_ACP_COMMAND` to its executable. For ZCode, the package searches the desktop installation for its native `zcode.cjs` runtime and builtin provider catalog.

Linux discovery has been exercised with `/opt/ZCode/resources/`. macOS and Windows candidates are provided; those platforms still need live verification. You can specify paths when an installation is not discovered automatically.

| Variable | Purpose |
|---|---|
| `AGY_ACP_COMMAND` | Path to the `agy` executable |
| `AGY_ACP_ALLOW_UNSAFE` | `1` explicitly enables Antigravity's permission-skip flag; disabled by default |
| `ZCODE_ACP_RUNTIME` | Path to the installed native `zcode.cjs` |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to the installation's builtin provider JSON |
| `ZCODE_ACP_DESKTOP_ASAR` | Path to ZCode's `app.asar`, used for desktop version metadata |
| `ZCODE_DATA_BASE_DIR` | Base directory containing ZCode's `.zcode/v2/` account data |
| `PASEO_HOME` | Paseo configuration directory; defaults to `~/.paseo` |

Set the same environment variables for setup and for the ACP client that launches the adapter. A path supplied in a terminal is not automatically inherited by a separately launched desktop client.

For a custom ZCode installation:

```sh
export ZCODE_ACP_RUNTIME="/path/to/ZCode/resources/glm/zcode.cjs"
export ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="/path/to/ZCode/resources/config/provider/zcode-builtin.json"
export ZCODE_ACP_DESKTOP_ASAR="/path/to/ZCode/resources/app.asar"
paseo-acp doctor --provider zcode
```

Use files from the same installed ZCode version. The adapter does not download or redistribute those files.

## Paseo setup and removal

```sh
paseo-acp setup --provider all
paseo-acp uninstall --provider all
```

Setup writes only its selected provider entries under `agents.providers` in Paseo's `config.json`:

- `choratools-antigravity`
- `choratools-zcode`

It records an installation receipt and saves a complete configuration backup under `PASEO_HOME/backups/`. Backups use private file permissions. Uninstall uses the receipt to restore previous entries; a provider entry you have since edited requires review instead of being silently overwritten.

Setup registers absolute Node and adapter paths. After moving the package or switching Node installations, run setup again to update the paths. Follow the command's reload instructions for your Paseo daemon.

To remove the globally installed commands as well:

```sh
npm uninstall -g @choratools/paseo-acp
```

Uninstalling this package leaves the official agents and their account data in place.

## Accounts and missing models

### Antigravity

Sign in with the official app or run `agy` interactively. The adapter inherits your native default model and probes `agy models` for the available catalog. If the probe is unavailable, the client offers **Default (Inherit)**. Changing the default model in Antigravity updates what the adapter inherits on its next runtime launch.

### Antigravity execution

The default is **Plan** mode. Standard and Auto Edit use the corresponding native execution settings. This bridge does not translate terminal permission prompts into ACP permission dialogs; a request that needs terminal approval may therefore be blocked.

For a workspace where you have explicitly chosen unattended execution, set `AGY_ACP_ALLOW_UNSAFE=1` in the ACP client's environment. This passes Antigravity's `--dangerously-skip-permissions` flag and permits actions without those approvals. Selecting Standard or Auto Edit alone does not enable this flag.

### ZCode Individual Coding Plan

```sh
paseo-acp login --provider zcode
```

The native runtime owns this login flow. Account credentials stay in the official local account store.

### ZCode Start Plan

Sign in through the official desktop app. Start Plan discovery uses that account's JWT, device identity, desktop version, and the official balance response. A missing, pending, or expired entitlement can therefore affect the available models even while a Coding Plan login works.

Trust Build is a plan benefit, rather than a standalone model. Select a model labelled **Start Plan**; its description can include the attached benefit. Available models and their limits follow the live account response.

After logging in or a benefit becomes active, start a new ACP connection to refresh the account catalog.

### A quota error after selecting a model

A listed model does not guarantee remaining quota. Provider errors, including exhausted weekly or monthly limits, are returned to the client. Select another plan's model only if that plan has its own valid access; otherwise follow the reset time reported by the provider.

## Troubleshooting

| Symptom | Check |
|---|---|
| Runtime not found | Run `doctor`; check the official installation and path overrides above. |
| Provider absent in Paseo | Run setup, follow its reload instruction, then create a new agent. |
| Start Plan absent | Open ZCode, verify desktop login and active benefits, then reconnect the ACP client. |
| Antigravity loses history after cancel | Its bridge cannot restore a child process's previous conversation. Start a new conversation. |
| ZCode model request fails | Read the provider's error; check login, entitlement, and remaining quota independently. |

When filing an issue, include OS, Node version, official runtime version, the client, and redacted `doctor` output. Never attach the account store, tokens, or private transcripts.
