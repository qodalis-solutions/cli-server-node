// Abstractions
export {
    ICliCommandAuthor,
    CliCommandAuthor,
    DefaultLibraryAuthor,
    CliProcessCommand,
    splitShellWords,
    joinShellWords,
    getPositionals,
    getPositionalText,
    quoteShellWord,
    ICliCommandParameterDescriptor,
    CliCommandParameterDescriptor,
    ICliCommandProcessor,
    CliCommandProcessor,
    ICliModule,
    CliModule,
    ICliProcessorFilter,
    CliTablePage,
    CliPageRequest,
    CliPaging,
    DEFAULT_TAKE,
    MAX_TAKE,
} from './abstractions';

// Models
export {
    CliServerOutput,
    CliServerResponse,
    CliServerCommandDescriptor,
    CliServerCommandParameterDescriptorDto,
    CliServerCommandExampleDto,
} from './models';

// Services
export {
    ICliCommandRegistry,
    CliCommandRegistry,
    ICliResponseBuilder,
    CliResponseBuilder,
    ICliCommandExecutorService,
    CliCommandExecutorService,
    CliCommandExecutorOptions,
    CliCommandUsageStats,
    CliCommandUsage,
    CliCommandUsageStatsResponse,
    CliOutputLimits,
    DEFAULT_MAX_TABLE_ROWS,
    CliEventSocketManager,
    CliShellSessionManager,
    CliShellSessionInfo,
    CliLogSocketManager,
    CliShellOptions,
    CliShellEnvOptions,
    CliShellAuthMode,
    CliShellAuthorizeContext,
    ShellCloseCodes,
} from './services';

// Server events
export { CliEventBus, publishCommandExecuted } from './services';
export { withFileStorageEvents } from './filesystem/file-storage-events';
export {
    CliEvent,
    CliEventAudience,
    CliEventHandler,
    ICliEventBus,
    CliEventBroadcastFn,
    CliEventPermissions,
    cliEventPatternMatches,
    toCliEventMessage,
    cliEventBusFromBroadcast,
    resolveCliEventBus,
} from '@qodalis/cli-server-abstractions';

// Server auth (implemented by the users plugin)
export {
    CliServerAuthContext,
    CliServerAuthError,
    CliServerAuditEntry,
    CliServerSessionEvent,
    CliServerRuntimeOptions,
    ICliServerAuth,
    CliServerPermissions,
    HOST_TOKENS_CANNOT_USE_CLI_ROUTES,
    isOriginAllowed,
    isSameOrigin,
    requestOrigin,
    clientAddress,
    trustedProxyHops,
    createServerAuthGate,
    ServerAuthGateOptions,
    requiredServerPermissions,
    authorizeWsUpgrade,
    rejectUpgrade,
    hostTokenRefusal,
    isCliRoute,
    isUnderPrefix,
} from './auth';

// MCP endpoint
export {
    CliMcpOptions,
    MCP_PROTOCOL_VERSIONS,
    MCP_SERVER_NAME,
    MCP_SERVER_VERSION,
    createMcpController,
    createMcpPreGate,
    resolveMcpOptions,
    collectMcpTools,
    isMcpToolAllowed,
    McpTool,
    McpToolProvider,
    McpToolResult,
    McpToolCallContext,
    McpToolAnnotations,
    McpInputSchema,
    McpPropertySchema,
    mcpObjectSchema,
    mcpError,
    mcpJson,
    validateMcpArguments,
    renderOutputsAsText,
    describePage,
    CommandsMcpToolProvider,
    ServerMcpToolProvider,
    FilesystemMcpToolProvider,
    DataExplorerMcpToolProvider,
    JobsMcpToolProvider,
    ConfigMcpToolProvider,
    mcpToolName,
} from './mcp';

// Config providers
export {
    CliConfigRegistry,
    CliConfigService,
    CliConfigServiceOptions,
    CliConfigAuditSink,
    CliConfigAuditChange,
    CliConfigCommandProcessor,
    CliServerConfigProvider,
    CliHostConfigProvider,
    CliHostEnvironmentOptions,
    CliHostOption,
    isSecretEnvironmentVariable,
    createCorsConfigProvider,
    createMcpConfigProvider,
    createFilesystemConfigProvider,
    CliCorsMode,
    DEFAULT_CONFIG_PROVIDER_ORDER,
} from './config';
export {
    CliConfigEntryType,
    CliConfigSource,
    CliConfigValue,
    CliConfigValidation,
    CliConfigEntry,
    CliConfigSection,
    CliConfigContext,
    ICliConfigProvider,
    ICliConfigWriter,
    CliConfigErrors,
    CliConfigUpdateResult,
    CliConfigEntryView,
    CliConfigSectionView,
    CliConfigProviderView,
    CliConfigUpdateRequest,
    CliConfigUpdateResponse,
    CliConfigError,
    CliConfigConflictError,
    CliConfigValidationError,
    CliConfigPermissions,
    CLI_CONFIG_CHANGED_EVENT,
    CLI_CONFIG_AUDIT_EVENT,
    ICliConfigService,
    ICliConfigStore,
    CliConfigStoredSection,
    InMemoryConfigStore,
    JsonFileConfigStore,
    JsonFileConfigStoreOptions,
    CliConfigStoreKind,
    CliConfigStoreDescription,
    CliConfigStorageKind,
    CliConfigProviderStorage,
    CliConfigListView,
    describeCliConfigStore,
    describeCliConfigStoreLine,
    describeCliConfigStoreName,
    CliStoredConfigProvider,
    CliStoredConfigProviderOptions,
    CliConfigSettingDefinition,
    CliConfigSectionDefinition,
    createCustomConfigProvider,
    cliConfigContext,
} from '@qodalis/cli-server-abstractions';

// Controllers
export { createCliController, CliControllerOptions } from './controllers/cli-controller';
export { createCliVersionController } from './controllers/cli-version-controller';
export { createFilesystemRouter } from './controllers/filesystem-controller';

// Extensions
export { CliBuilder } from './extensions';

// Permission catalog
export {
    CliPermission,
    CliPermissionInput,
    CliPermissionSurface,
    CliPermissionCatalog,
    CORE_PERMISSIONS,
} from './permissions/cli-permission-catalog';

// Jobs plugin (re-export for backward compatibility)
export {
    CliJobsBuilder,
    CliJobScheduler,
    CliJobExecutionContext,
    CliJobLogger,
    InMemoryJobStorageProvider,
    JobDto,
    JobError,
    parseInterval,
    createCliJobsController,
} from '@qodalis/cli-server-plugin-jobs';

// Filesystem (legacy)
export { FileSystemOptions, FileSystemApiOptions, DEFAULT_MAX_UPLOAD_BYTES, FileSystemPathValidator } from './filesystem';

// Filesystem plugin
export {
    IFileStorageProvider,
    FileEntry,
    FileStat,
    InMemoryFileStorageProvider,
    OsFileStorageProvider,
    OsProviderOptions,
    FileSystemModule,
    FileNotFoundError,
    PermissionDeniedError,
    FileExistsError,
    NotADirectoryError,
    IsADirectoryError,
} from '@qodalis/cli-server-plugin-filesystem';

// Filesystem JSON provider
export { JsonFileStorageProvider, JsonFileProviderOptions } from '@qodalis/cli-server-plugin-filesystem-json';

// Filesystem SQLite provider
export { SqliteFileStorageProvider, SqliteProviderOptions } from '@qodalis/cli-server-plugin-filesystem-sqlite';

// Filesystem S3 provider
export { S3FileStorageProvider, S3ProviderOptions } from '@qodalis/cli-server-plugin-filesystem-s3';

// Processors
export { CliHttpCommandProcessor } from './processors/cli-http-command-processor';

// Utilities
export { Logger, createLogger } from './utils/logger';

// Server factory
export { getCliCaller, runAsCliCaller } from './auth/cli-caller';
export { createCliServer, CliServerOptions, CliServerResult, CliServerMcp, MountablePlugin } from './create-cli-server';

// Restart: the pending list, the modes and the graceful shutdown
export {
    CliServerRestart,
    CliServerRestartOptions,
    CliServerRestartContext,
    CliServerRestartRuntime,
    CliServerRestartServices,
    DEFAULT_RESTART_EXIT_CODE,
    DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
    RESTART_NOT_SUPPORTED,
    detectSupervisor,
    createRestartController,
} from './restart';
export {
    CLI_SERVER_RESTART_PERMISSION,
    CLI_SERVER_RESTART_REQUIRED_EVENT,
    CLI_SERVER_RESTARTING_EVENT,
    CLI_SERVER_RESTART_AUDIT_EVENT,
    CLI_SERVER_RESTART_CLOSE_CODE,
    CliServerRestartMode,
    CliServerSupervisor,
    CliRestartRequirement,
    CliRestartRequirementInput,
    CliServerRestartStatus,
    CliServerRestartRequest,
    CliServerRestartError,
    ICliServerRestart,
} from '@qodalis/cli-server-abstractions';
// Server plugins installed at runtime (from the marketplace): the loader and the entry point contract
export {
    CliServerPlugins,
    CliServerPluginsOptions,
    CliServerPluginsHost,
    DEFAULT_DATA_DIR,
    SHARED_PACKAGES,
    isValidServerPluginName,
    isValidServerPluginPackage,
    isValidServerPluginVersion,
    serverPluginEntryPath,
    serverPluginManifestOf,
} from './server-plugins';
export {
    CLI_SERVER_PLUGIN_KIND,
    CLI_SERVER_PLUGINS_DIR,
    CLI_SERVER_PLUGINS_FILE,
    CLI_PLUGINS_INSTALL_PERMISSION,
    CliServerPluginManifest,
    CliPluginLogger,
    CliPluginBuilder,
    CliPluginSettingsOptions,
    CliPluginContext,
    CliPluginEntryResult,
    CliPluginEntry,
    CliServerPluginRecord,
    CliServerPluginStatus,
    CliServerPluginState,
    ICliServerPlugins,
} from '@qodalis/cli-server-abstractions';
