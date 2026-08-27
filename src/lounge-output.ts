import type { LoungeNoticeState, LoungeStatusResult } from './lounge-types.js';

export function loungeWaitNotice(
  notice: LoungeNoticeState,
  noticeChanged: boolean,
): LoungeNoticeState {
  return noticeChanged
    ? notice
    : {
        loungeId: notice.loungeId,
        noticeRevision: notice.noticeRevision,
        pinnedNotice: null,
      };
}

export function compactLoungeStatus(status: LoungeStatusResult): Record<string, unknown> {
  return {
    detail: 'compact',
    loungeId: status.loungeId,
    requestingAgentId: status.requestingAgentId,
    members: status.members.map(({ agentId, displayName, presence }) => ({
      agentId,
      displayName,
      presence,
    })),
    memberCount: status.members.length,
    pendingMessageCount: status.members.reduce((total, member) => total + member.pendingMessages, 0),
    deliveredMessageCount: status.members.reduce((total, member) => total + member.deliveredMessages, 0),
    workNoteRevision: status.workNoteRevision,
    workNote: status.workNote,
    noticeRevision: status.noticeRevision,
    pinnedNotice: status.pinnedNotice === null
      ? null
      : {
          revision: status.pinnedNotice.revision,
          pinnedByAgentId: status.pinnedNotice.pinnedByAgentId,
          pinnedAtMs: status.pinnedNotice.pinnedAtMs,
          bodyAvailableInFullStatus: true,
        },
    recentSentMessagesAvailableInFullStatus: status.recentSentMessages.length > 0,
    memberWorkNotesAvailableInFullStatus: status.memberWorkNotes !== null,
  };
}
