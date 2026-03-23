/** Summary of the current AWS configuration with secrets masked. */
export interface AwsConfigSummary {
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    profile?: string;
}

/** Manages in-memory AWS configuration (credentials, region, profile). */
export class AwsConfigService {
    private _accessKeyId?: string;
    private _secretAccessKey?: string;
    private _region?: string;
    private _profile?: string;

    /** Returns the configured AWS access key ID, or undefined if not set. */
    getAccessKeyId(): string | undefined { return this._accessKeyId; }

    /** Returns the configured AWS secret access key, or undefined if not set. */
    getSecretAccessKey(): string | undefined { return this._secretAccessKey; }

    /** Returns the configured AWS region, or undefined if not set. */
    getRegion(): string | undefined { return this._region; }

    /** Returns the configured AWS profile name, or undefined if not set. */
    getProfile(): string | undefined { return this._profile; }

    /**
     * Sets the AWS access key ID and secret access key.
     * @param accessKeyId - The AWS access key ID.
     * @param secretAccessKey - The AWS secret access key.
     */
    setCredentials(accessKeyId: string, secretAccessKey: string): void {
        this._accessKeyId = accessKeyId;
        this._secretAccessKey = secretAccessKey;
    }

    /**
     * Sets the AWS region.
     * @param region - The AWS region identifier (e.g., 'us-east-1').
     */
    setRegion(region: string): void { this._region = region; }

    /**
     * Sets the AWS profile name.
     * @param profile - The profile name from ~/.aws/credentials or ~/.aws/config.
     */
    setProfile(profile: string): void { this._profile = profile; }

    /**
     * Returns a summary of the current configuration with secrets masked.
     * @returns An {@link AwsConfigSummary} with the access key partially masked and the secret fully masked.
     */
    getConfigSummary(): AwsConfigSummary {
        return {
            accessKeyId: this._accessKeyId ? this.maskKey(this._accessKeyId) : undefined,
            secretAccessKey: this._secretAccessKey ? '****' : undefined,
            region: this._region,
            profile: this._profile,
        };
    }

    /**
     * Masks a key string, showing only the first 4 and last 5 characters.
     * @param key - The key string to mask.
     * @returns The masked key string.
     */
    private maskKey(key: string): string {
        if (key.length <= 8) return '****';
        return key.slice(0, 4) + '***' + key.slice(-5);
    }
}
