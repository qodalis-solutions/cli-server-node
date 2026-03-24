import { describe, it, expect, beforeEach } from 'vitest';
import { AwsConfigService } from '../services/aws-config-service';

describe('AwsConfigService', () => {
    let service: AwsConfigService;

    beforeEach(() => {
        service = new AwsConfigService();
    });

    it('should return undefined for unconfigured values', () => {
        expect(service.getAccessKeyId()).toBeUndefined();
        expect(service.getSecretAccessKey()).toBeUndefined();
        expect(service.getRegion()).toBeUndefined();
    });

    it('should store and retrieve credentials', () => {
        service.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        expect(service.getAccessKeyId()).toBe('AKIAIOSFODNN7EXAMPLE');
        expect(service.getSecretAccessKey()).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    });

    it('should store and retrieve region', () => {
        service.setRegion('eu-west-1');
        expect(service.getRegion()).toBe('eu-west-1');
    });

    it('should mask secrets in getConfigSummary', () => {
        service.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        service.setRegion('us-east-1');
        const summary = service.getConfigSummary();
        expect(summary.accessKeyId).toBe('AKIA***AMPLE');
        expect(summary.secretAccessKey).toBe('****');
        expect(summary.region).toBe('us-east-1');
    });

    it('should store and retrieve profile', () => {
        service.setProfile('production');
        expect(service.getProfile()).toBe('production');
    });
});
