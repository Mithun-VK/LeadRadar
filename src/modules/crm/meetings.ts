/**
 * Meetings.
 *
 * Deliberately NOT integrated with any calendar. The brief is explicit that no
 * calendar integration should be invented, and a fake one is worse than none: an
 * operator who believes an invite was sent, when it was not, misses the meeting
 * and the prospect concludes they are unreliable.
 *
 * So this stores what a person tells it — a time, a duration, and whatever
 * meeting link they paste — and tracks the outcome. `externalEventId` exists on
 * the model, unused, so a real Google Calendar sync can be added later without a
 * migration.
 */
import { AppError, notFound } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';

import { createActivity } from './activities';
import { applyLeadEvent } from './leads';
import { moveDealStage } from './deals';

export type MeetingStatus = 'SCHEDULED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'RESCHEDULED';

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  NO_SHOW: 'No show',
  CANCELLED: 'Cancelled',
  RESCHEDULED: 'Rescheduled',
};

export interface CreateMeetingInput {
  readonly businessId: string;
  readonly dealId?: string | null;
  readonly title: string;
  readonly scheduledAt: Date;
  readonly durationMinutes?: number;
  readonly meetingUrl?: string | null;
  readonly notes?: string | null;
}

/**
 * Books a meeting and moves everything that follows from it.
 *
 * A meeting is the strongest signal short of a proposal, so it advances the lead
 * and the deal in the same operation. Doing that here rather than leaving it to
 * the caller means the pipeline cannot drift just because someone booked a
 * meeting from an unusual screen.
 */
export async function createMeeting(tenant: TenantContext, input: CreateMeetingInput) {
  const lead = await db().business.findFirst({
    where: { id: input.businessId, organizationId: tenant.organizationId },
    select: { id: true, displayName: true },
  });

  if (!lead) throw notFound('Lead', { businessId: input.businessId });

  if (Number.isNaN(input.scheduledAt.getTime())) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Meeting time is not a valid date',
      safeMessage: 'That meeting time could not be understood.',
    });
  }

  const meeting = await db().meeting.create({
    data: {
      organizationId: tenant.organizationId,
      businessId: lead.id,
      dealId: input.dealId ?? null,
      title: input.title,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes ?? 30,
      meetingUrl: input.meetingUrl ?? null,
      notes: input.notes ?? null,
      status: 'SCHEDULED',
      ownerUserId: tenant.userId ?? null,
    },
  });

  // A calendar entry the operator will see in the work queue.
  await createActivity(tenant, {
    businessId: lead.id,
    dealId: input.dealId ?? null,
    type: 'MEETING',
    title: input.title,
    description: input.meetingUrl ? `Meeting link: ${input.meetingUrl}` : null,
    dueAt: input.scheduledAt,
  });

  await applyLeadEvent(
    tenant,
    lead.id,
    'MEETING_BOOKED',
    `Meeting scheduled for ${input.scheduledAt.toISOString()}`,
    'USER',
  );

  if (input.dealId) {
    // Best-effort: a deal already past MEETING stays where it is.
    try {
      await moveDealStage(tenant, {
        dealId: input.dealId,
        to: 'MEETING',
        reason: 'Meeting scheduled',
        source: 'USER',
        syncLead: false,
      });
    } catch {
      logger().debug({ dealId: input.dealId }, 'Deal already past the meeting stage');
    }
  }

  logger().info({ meetingId: meeting.id, businessId: lead.id }, 'Meeting scheduled');
  return meeting;
}

export interface UpdateMeetingInput {
  readonly title?: string;
  readonly scheduledAt?: Date;
  readonly durationMinutes?: number;
  readonly meetingUrl?: string | null;
  readonly status?: MeetingStatus;
  readonly notes?: string | null;
}

export async function updateMeeting(
  tenant: TenantContext,
  meetingId: string,
  input: UpdateMeetingInput,
) {
  const meeting = await db().meeting.findFirst({
    where: { id: meetingId, organizationId: tenant.organizationId },
    select: { id: true, businessId: true, status: true, dealId: true },
  });

  if (!meeting) throw notFound('Meeting', { meetingId });

  const updated = await db().meeting.update({
    where: { id: meeting.id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.scheduledAt !== undefined && { scheduledAt: input.scheduledAt }),
      ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }),
      ...(input.meetingUrl !== undefined && { meetingUrl: input.meetingUrl }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
  });

  /**
   * A no-show is recorded but does NOT move the lead backwards.
   *
   * Someone who missed a call is still further along than someone who never
   * booked one, and regressing them would misrepresent the relationship and
   * distort the funnel.
   */
  if (input.status === 'NO_SHOW') {
    await createActivity(tenant, {
      businessId: meeting.businessId,
      dealId: meeting.dealId,
      type: 'FOLLOW_UP',
      title: 'Follow up after a missed meeting',
      description: 'The lead did not attend. Reschedule or close.',
      dueAt: new Date(),
    });
  }

  return updated;
}

export async function listMeetings(
  tenant: TenantContext,
  filters: { businessId?: string; upcomingOnly?: boolean; limit?: number } = {},
) {
  return db().meeting.findMany({
    where: {
      organizationId: tenant.organizationId,
      ...(filters.businessId && { businessId: filters.businessId }),
      ...(filters.upcomingOnly && {
        status: 'SCHEDULED',
        scheduledAt: { gte: new Date() },
      }),
    },
    orderBy: { scheduledAt: filters.upcomingOnly ? 'asc' : 'desc' },
    take: filters.limit ?? 100,
    include: {
      business: { select: { id: true, displayName: true, city: true, primaryEmail: true } },
      deal: { select: { id: true, name: true, stage: true } },
    },
  });
}
