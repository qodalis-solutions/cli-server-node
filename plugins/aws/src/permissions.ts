/** The permissions of the `aws` command (enforced on a protected server, along the command chain). */
export const AwsPermissions = {
    /** Every `aws` command: read the account's resources (list, describe, logs, metrics, scan, query, presigned GET URLs). */
    Read: 'aws:read',
    /** The commands that change something: s3 cp/rm/mb/rb, ec2 start/stop/reboot, lambda invoke, sqs send/purge, sns publish, configure set. */
    Write: 'aws:write',
} as const;

/** Added to the server's permission catalog with the module. */
export const AWS_PERMISSION_ENTRIES = [
    { name: AwsPermissions.Read, description: 'Read AWS resources from the terminal (aws commands)', group: 'AWS' },
    { name: AwsPermissions.Write, description: 'Change AWS resources and the AWS configuration from the terminal', group: 'AWS' },
];
