import { z } from "zod";
import prisma from "@/lib/db";
import { SectionType } from "@/models/profile.model";
import { McpSaveTailoredResumeSchema } from "@/models/mcp.schema";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";

export async function handleSaveTailoredResume(
  input: z.infer<typeof McpSaveTailoredResumeSchema>,
  userId: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const rateCheck = checkMcpRateLimit(userId);
  if (!rateCheck.allowed) {
    const resetSec = Math.ceil(rateCheck.resetIn / 1000);
    return {
      content: [
        { type: "text", text: `Rate limit exceeded. Try again in ${resetSec}s.` },
      ],
    };
  }

  // Same MCP-provenance scope as update_job/save_match_result: this tool can
  // only link resumes to jobs that were themselves created through MCP.
  const job = await prisma.job.findFirst({
    where: { id: input.jobId, userId, createdVia: { not: null } },
    select: {
      id: true,
      JobTitle: { select: { label: true } },
      Company: { select: { label: true } },
    },
  });
  if (!job) {
    return {
      content: [
        {
          type: "text",
          text: "Job not found, not owned by this token's user, or not eligible for a resume link via MCP.",
        },
      ],
    };
  }

  const baseTitle =
    input.title?.trim() || `${job.Company.label} – ${job.JobTitle.label}`;

  try {
    const resumeId = await prisma.$transaction(async (tx) => {
      // Build a unique title the same way createResumeProfile does, so a
      // repeat tailoring pass for the same role doesn't collide silently.
      const existingTitles = await tx.resume.findMany({
        where: { profile: { userId } },
        select: { title: true },
      });
      const taken = new Set(existingTitles.map((r) => r.title.toLowerCase()));
      let uniqueTitle = baseTitle;
      let counter = 2;
      while (taken.has(uniqueTitle.toLowerCase())) {
        uniqueTitle = `${baseTitle} (${counter++})`;
      }

      let profile = await tx.profile.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (!profile) {
        profile = await tx.profile.create({
          data: { userId },
          select: { id: true },
        });
      }

      const resume = await tx.resume.create({
        data: { profileId: profile.id, title: uniqueTitle },
        select: { id: true },
      });

      // Stored as a single section rather than parsed into structured work
      // experience/education entries — this tool preserves exactly what the
      // agent produced (and sent), it doesn't re-run the AI-assisted import
      // pipeline that structures a resume section-by-section.
      const section = await tx.resumeSection.create({
        data: {
          resumeId: resume.id,
          sectionTitle: "Tailored Resume",
          sectionType: SectionType.SUMMARY,
        },
      });
      await tx.resumeSection.update({
        where: { id: section.id },
        data: { summary: { create: { content: input.resumeText } } },
      });

      await tx.job.update({
        where: { id: job.id },
        data: { resumeId: resume.id },
      });

      return resume.id;
    });

    return {
      content: [
        {
          type: "text",
          text: `Saved tailored resume "${baseTitle}" as resume ${resumeId} and linked it to job ${job.id}.`,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error?.message ?? "Unknown error"}` }],
    };
  }
}
