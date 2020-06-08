import * as ec2 from "@aws-cdk/aws-ec2"
import * as ecr from "@aws-cdk/aws-ecr"
import * as ecs from "@aws-cdk/aws-ecs"
import * as events from "@aws-cdk/aws-events"
import * as targets from "@aws-cdk/aws-events-targets"
import * as iam from "@aws-cdk/aws-iam"
import * as logs from "@aws-cdk/aws-logs"
import * as s3 from "@aws-cdk/aws-s3"
import * as cdk from "@aws-cdk/core"
import { EcrAsset } from "./asset"

export class WorkerStack extends cdk.Stack {
  constructor(
    scope: cdk.Construct,
    id: string,
    props: cdk.StackProps & {
      resourcePrefix: string
      vpcId: string
      webBucketName: string
      workerAsset: EcrAsset
    },
  ) {
    super(scope, id, props)

    const region = cdk.Stack.of(this).region
    const account = cdk.Stack.of(this).account

    const vpc = ec2.Vpc.fromLookup(this, "Vpc", {
      vpcId: props.vpcId,
    })

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
    })

    const image = ecs.ContainerImage.fromEcrRepository(
      ecr.Repository.fromRepositoryAttributes(this, "EcrRepo", {
        repositoryArn: props.workerAsset.ecrRepoArn,
        repositoryName: props.workerAsset.ecrRepoName,
      }),
      props.workerAsset.dockerTag,
    )

    const webBucket = s3.Bucket.fromBucketName(
      this,
      "WebBucket",
      props.webBucketName,
    )

    // The actual application being run as a task.

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
    })

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      family: `${props.resourcePrefix}-worker`,
      cpu: 1024,
      memoryLimitMiB: 2048,
    })

    taskDef.addContainer("app", {
      image,
      logging: ecs.LogDriver.awsLogs({
        logGroup,
        streamPrefix: "app",
      }),
      environment: {
        PARAMS_PREFIX: `/${props.resourcePrefix}/`,
      },
    })

    taskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [webBucket.arnForObjects("*")],
      }),
    )

    taskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: ["*"], // Cannot be restricted.
      }),
    )

    taskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/${props.resourcePrefix}/*`,
        ],
      }),
    )

    // No need for any inbound rules, but we need a security group to start task.
    const securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
    })

    const scheduleRule = new events.Rule(this, "ScheduleRule", {
      schedule: events.Schedule.expression("cron(0 4 * * ? *)"),
    })

    scheduleRule.addTarget(
      new targets.EcsTask({
        cluster,
        taskDefinition: taskDef,
        securityGroup,
        subnetSelection: {
          subnetType: ec2.SubnetType.PUBLIC,
        },
      }),
    )
  }
}