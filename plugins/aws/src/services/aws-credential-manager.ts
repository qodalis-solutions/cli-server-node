import { AwsConfigService } from './aws-config-service';

export interface AwsClientOptions {
    region?: string;
    profile?: string;
}

export class AwsCredentialManager {
    private readonly _clientCache = new Map<string, any>();

    constructor(private readonly config: AwsConfigService) {}

    getClientConfig(overrides?: AwsClientOptions): Record<string, any> {
        const config: Record<string, any> = {};
        const region = overrides?.region ?? this.config.getRegion() ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
        if (region) config.region = region;
        const accessKeyId = this.config.getAccessKeyId() ?? process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = this.config.getSecretAccessKey() ?? process.env.AWS_SECRET_ACCESS_KEY;
        if (accessKeyId && secretAccessKey) {
            config.credentials = { accessKeyId, secretAccessKey };
        }
        return config;
    }

    getClient<T>(ClientClass: new (config: Record<string, any>) => T, overrides?: AwsClientOptions): T {
        const region = overrides?.region ?? this.config.getRegion() ?? 'default';
        const profile = overrides?.profile ?? this.config.getProfile() ?? 'default';
        const key = `${ClientClass.name}:${region}:${profile}`;
        if (!this._clientCache.has(key)) {
            this._clientCache.set(key, new ClientClass(this.getClientConfig(overrides)));
        }
        return this._clientCache.get(key) as T;
    }

    clearCache(): void {
        this._clientCache.clear();
    }
}
