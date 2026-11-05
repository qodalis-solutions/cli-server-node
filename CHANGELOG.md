# Change Log

Notable changes to the Node CLI server packages (`@qodalis/cli-server-node`, `@qodalis/cli-server-abstractions`,
`@qodalis/cli-server-plugin-*`). Every package shares one version with the .NET and Python servers.

## 1.0.0-beta.14

### Dashboard name and icon

- `CliAdminBuilder.setBranding({ name, iconUrl, cliName })`: the name and icon an application ships the dashboard
  under, and its terminal's name, served in `/qcli/admin/theme.json` and validated when set. Defaults: Qodalis Cli
  Admin with the Qodalis Solutions logo. See [Name and icon](plugins/admin/README.md#name-and-icon).

### Other packages

- Released at `1.0.0-beta.14` with the .NET and Python servers; no other change.
