-- CreateEnum
CREATE TYPE "DeploymentMode" AS ENUM ('LOCAL', 'NETWORK');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('PUBLIC', 'PRIVATE', 'DIRECT');

-- CreateEnum
CREATE TYPE "ChannelRole" AS ENUM ('OWNER', 'MODERATOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('TEXT', 'MARKDOWN', 'FILE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AgentTriggerMode" AS ENUM ('MENTIONS_ONLY', 'ALL_MESSAGES', 'DISABLED');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('GLOBAL', 'CHANNEL', 'USER');

-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('BLOCK', 'ALLOW', 'LOG', 'REQUIRE_APPROVAL');

-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('TOOL', 'FILE', 'CHANNEL', 'AGENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "McpServerStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'UNHEALTHY', 'FAILED');

-- CreateEnum
CREATE TYPE "AttachmentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'QUARANTINED', 'FAILED');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AgentDocType" AS ENUM ('AGENT_MD', 'IDENTITY_MD', 'MEMORY_MD', 'HEARTBEAT_MD');

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "deploymentMode" "DeploymentMode" NOT NULL DEFAULT 'LOCAL',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMembership" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "acceptedBy" UUID,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMembership" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ChannelRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),

    CONSTRAINT "ChannelMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "senderType" "SenderType" NOT NULL,
    "content" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'TEXT',
    "metadata" JSONB,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReaction" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "uploadedBy" UUID,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "virusScanStatus" "AttachmentScanStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggerMode" "AgentTriggerMode" NOT NULL DEFAULT 'MENTIONS_ONLY',
    "primaryChannelId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIdentity" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "avatarUrl" TEXT,
    "persona" TEXT,
    "voiceTone" TEXT,
    "systemPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "channelId" UUID,
    "userId" UUID,
    "scope" "MemoryScope" NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTool" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mcpServerToolId" UUID,
    "toolName" TEXT NOT NULL,
    "config" JSONB,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCronJob" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "schedule" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCronJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChannelMembership" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "addedBy" UUID,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChannelMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToolCall" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "messageId" UUID,
    "toolName" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "providerName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationSummary" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "coversFromMessageId" TEXT NOT NULL,
    "covesToMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceFile" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "agentId" UUID,
    "uploadedBy" UUID,
    "docType" "AgentDocType",
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceFileVersion" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceFileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "condition" JSONB NOT NULL,
    "action" "RuleAction" NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleViolation" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "agentId" UUID,
    "reportedBy" UUID,
    "context" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" UUID NOT NULL,
    "agentToolCallId" UUID NOT NULL,
    "resolverId" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdBy" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "args" JSONB,
    "env" TEXT,
    "status" "McpServerStatus" NOT NULL DEFAULT 'STOPPED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServerTool" (
    "id" UUID NOT NULL,
    "serverId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inputSchema" JSONB,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServerTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMembership_userId_idx" ON "WorkspaceMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMembership_workspaceId_userId_key" ON "WorkspaceMembership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");

-- CreateIndex
CREATE INDEX "Channel_workspaceId_idx" ON "Channel"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelMembership_userId_idx" ON "ChannelMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMembership_channelId_userId_key" ON "ChannelMembership"("channelId", "userId");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "MessageReaction_userId_idx" ON "MessageReaction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_fileKey_key" ON "Attachment"("fileKey");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_workspaceId_slug_key" ON "Agent"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_agentId_key" ON "AgentIdentity"("agentId");

-- CreateIndex
CREATE INDEX "AgentMemory_agentId_scope_idx" ON "AgentMemory"("agentId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_agentId_scope_key_channelId_userId_key" ON "AgentMemory"("agentId", "scope", "key", "channelId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTool_agentId_toolName_key" ON "AgentTool"("agentId", "toolName");

-- CreateIndex
CREATE INDEX "AgentCronJob_agentId_idx" ON "AgentCronJob"("agentId");

-- CreateIndex
CREATE INDEX "AgentChannelMembership_channelId_idx" ON "AgentChannelMembership"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentChannelMembership_agentId_channelId_key" ON "AgentChannelMembership"("agentId", "channelId");

-- CreateIndex
CREATE INDEX "AgentToolCall_agentId_createdAt_idx" ON "AgentToolCall"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_agentId_key" ON "ProviderConfig"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_agentId_key" ON "OAuthToken"("agentId");

-- CreateIndex
CREATE INDEX "ConversationSummary_channelId_agentId_createdAt_idx" ON "ConversationSummary"("channelId", "agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceFile_key_key" ON "WorkspaceFile"("key");

-- CreateIndex
CREATE INDEX "WorkspaceFile_workspaceId_idx" ON "WorkspaceFile"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceFile_agentId_idx" ON "WorkspaceFile"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceFileVersion_key_key" ON "WorkspaceFileVersion"("key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceFileVersion_fileId_version_key" ON "WorkspaceFileVersion"("fileId", "version");

-- CreateIndex
CREATE INDEX "Rule_workspaceId_priority_idx" ON "Rule"("workspaceId", "priority");

-- CreateIndex
CREATE INDEX "RuleViolation_ruleId_createdAt_idx" ON "RuleViolation"("ruleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingApproval_agentToolCallId_key" ON "PendingApproval"("agentToolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "McpServerTool_serverId_name_key" ON "McpServerTool"("serverId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PushToken_userId_deviceId_key" ON "PushToken"("userId", "deviceId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_acceptedBy_fkey" FOREIGN KEY ("acceptedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMembership" ADD CONSTRAINT "ChannelMembership_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMembership" ADD CONSTRAINT "ChannelMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_mcpServerToolId_fkey" FOREIGN KEY ("mcpServerToolId") REFERENCES "McpServerTool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCronJob" ADD CONSTRAINT "AgentCronJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelMembership" ADD CONSTRAINT "AgentChannelMembership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChannelMembership" ADD CONSTRAINT "AgentChannelMembership_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolCall" ADD CONSTRAINT "AgentToolCall_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolCall" ADD CONSTRAINT "AgentToolCall_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConfig" ADD CONSTRAINT "ProviderConfig_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSummary" ADD CONSTRAINT "ConversationSummary_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSummary" ADD CONSTRAINT "ConversationSummary_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceFile" ADD CONSTRAINT "WorkspaceFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceFile" ADD CONSTRAINT "WorkspaceFile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceFile" ADD CONSTRAINT "WorkspaceFile_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceFileVersion" ADD CONSTRAINT "WorkspaceFileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "WorkspaceFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleViolation" ADD CONSTRAINT "RuleViolation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleViolation" ADD CONSTRAINT "RuleViolation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleViolation" ADD CONSTRAINT "RuleViolation_reportedBy_fkey" FOREIGN KEY ("reportedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_agentToolCallId_fkey" FOREIGN KEY ("agentToolCallId") REFERENCES "AgentToolCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_resolverId_fkey" FOREIGN KEY ("resolverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServerTool" ADD CONSTRAINT "McpServerTool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
