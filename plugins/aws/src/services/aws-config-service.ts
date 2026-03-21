export interface AwsConfigSummary {
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    profile?: string;
}

export class AwsConfigService {
    private _accessKeyId?: string;
    private _secretAccessKey?: string;
    private _region?: string;
    private _profile?: string;

    getAccessKeyId(): string | undefined { return this._accessKeyId; }
    getSecretAccessKey(): string | undefined { return this._secretAccessKey; }
    getRegion(): string | undefined { return this._region; }
    getProfile(): string | undefined { return this._profile; }

    setCredentials(accessKeyId: string, secretAccessKey: string): void {
        this._accessKeyId = accessKeyId;
        this._secretAccessKey = secretAccessKey;
    }
    setRegion(region: string): void { this._region = region; }
    setProfile(profile: string): void { this._profile = profile; }

    getConfigSummary(): AwsConfigSummary {
        return {
            accessKeyId: this._accessKeyId ? this.maskKey(this._accessKeyId) : undefined,
            secretAccessKey: this._secretAccessKey ? '****' : undefined,
            region: this._region,
            profile: this._profile,
        };
    }

    private maskKey(key: string): string {
        if (key.length <= 8) return '****';
        return key.slice(0, 4) + '***' + key.slice(-5);
    }
}
