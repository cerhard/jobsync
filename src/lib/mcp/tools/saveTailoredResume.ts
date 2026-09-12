import path from "path";
import fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import { z } from "zod";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { SectionType } from "@/models/profile.model";
import { McpSaveTailoredResumeSchema } from "@/models/mcp.schema";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { getTimestampedFileName } from "@/lib/utils";
import { validateResumeFileBytes } from "@/lib/resumeFileValidation";

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

  // Same size/magic-byte checks as the human upload route in
  // src/app/api/profile/resume/route.ts, since this is the same file store.
  let fileBuffer: Buffer | undefined;
  if (input.fileBase64) {
    fileBuffer = Buffer.from(input.fileBase64, "base64");
    if (fileBuffer.length === 0 || fileBuffer.length > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES) {
      return {
        content: [
          {
            type: "text",
            text: `File must be non-empty and under ${APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES / (1024 * 1024)}MB.`,
          },
        ],
      };
    }
    if (!validateResumeFileBytes(fileBuffer, input.mimeType!)) {
      return {
        content: [
          {
            type: "text",
            text: "File content does not match the declared mimeType (failed magic-byte check).",
          },
        ],
      };
    }
  }

  const baseTitle =
    input.title?.trim() || `${job.Company.label} – ${job.JobTitle.label}`;

  // Written before the transaction: disk writes can't be rolled back, so if
  // this fails, nothing has been created in the DB yet to clean up.
  let filePath: string | undefined;
  if (fileBuffer) {
    const uploadDir = path.join(APP_CONSTANTS.UPLOADS_DIR, "files", "resumes");
    if (!fs.existsSync(uploadDir)) {
      await mkdir(uploadDir, { recursive: true });
    }
    filePath = path.join(uploadDir, getTimestampedFileName(input.fileName!));
    await writeFile(filePath, fileBuffer);
  }

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

      let fileId: string | undefined;
      if (filePath) {
        const file = await tx.file.create({
          data: {
            fileName: input.fileName!,
            filePath,
            fileType: "resume",
          },
          select: { id: true },
        });
        fileId = file.id;
      }

      const resume = await tx.resume.create({
        data: { profileId: profile.id, title: uniqueTitle, FileId: fileId },
        select: { id: true },
      });

      // Text path only: preserved as a single section rather than parsed
      // into structured work experience/education entries — this stores
      // exactly what the agent produced, it doesn't re-run the AI-assisted
      // import pipeline that structures a resume section-by-section.
      if (input.resumeText) {
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
      }

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
