import { handleSaveTailoredResume } from "@/lib/mcp/tools/saveTailoredResume";
import { McpSaveTailoredResumeSchema } from "@/models/mcp.schema";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import { writeFile, mkdir } from "fs/promises";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    job: { findFirst: vi.fn(), update: vi.fn() },
    resume: { findMany: vi.fn(), create: vi.fn() },
    resumeSection: { create: vi.fn(), update: vi.fn() },
    profile: { findFirst: vi.fn(), create: vi.fn() },
    file: { create: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(mPrismaClient)),
  };
  return { PrismaClient: vi.fn(function () { return mPrismaClient; }) };
});

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkMcpRateLimit: vi.fn(() => ({ allowed: true, resetIn: 0 })),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => true) }, existsSync: vi.fn(() => true) };
});

vi.mock("fs/promises", () => {
  const mkdir = vi.fn();
  const writeFile = vi.fn();
  return { mkdir, writeFile, default: { mkdir, writeFile } };
});

const tailoredResumeText =
  "A".repeat(210) + "\n\nJane Doe\nSenior Backend Engineer\n...";

// %PDF magic bytes followed by filler, base64-encoded
const validPdfBase64 = Buffer.concat([
  Buffer.from([0x25, 0x50, 0x44, 0x46]),
  Buffer.from("filler-pdf-bytes"),
]).toString("base64");

const jobRow = {
  id: "job-1",
  JobTitle: { label: "Senior Backend Engineer" },
  Company: { label: "Acme Corp" },
};

describe("McpSaveTailoredResumeSchema", () => {
  it("accepts resumeText alone", () => {
    expect(
      McpSaveTailoredResumeSchema.safeParse({ jobId: "job-1", resumeText: tailoredResumeText }).success,
    ).toBe(true);
  });

  it("accepts fileBase64 + fileName + mimeType together", () => {
    expect(
      McpSaveTailoredResumeSchema.safeParse({
        jobId: "job-1",
        fileBase64: "aGVsbG8=",
        fileName: "resume.pdf",
        mimeType: "application/pdf",
      }).success,
    ).toBe(true);
  });

  it("rejects when neither resumeText nor a file is supplied", () => {
    expect(McpSaveTailoredResumeSchema.safeParse({ jobId: "job-1" }).success).toBe(false);
  });

  it("rejects a partial file trio (fileBase64 without fileName/mimeType)", () => {
    expect(
      McpSaveTailoredResumeSchema.safeParse({
        jobId: "job-1",
        fileBase64: "aGVsbG8=",
      }).success,
    ).toBe(false);
  });
});

describe("handleSaveTailoredResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.job.findFirst as any).mockResolvedValue(jobRow);
    (prisma.resume.findMany as any).mockResolvedValue([]);
    (prisma.profile.findFirst as any).mockResolvedValue({ id: "profile-1" });
    (prisma.resume.create as any).mockResolvedValue({ id: "resume-1" });
    (prisma.resumeSection.create as any).mockResolvedValue({ id: "section-1" });
    (prisma.resumeSection.update as any).mockResolvedValue({});
    (prisma.file.create as any).mockResolvedValue({ id: "file-1" });
    (prisma.job.update as any).mockResolvedValue({});
    (fs.existsSync as any).mockReturnValue(true);
  });

  describe("text path (resumeText)", () => {
    it("creates a resume with no attached file, a summary section with the tailored text, and links it to the job", async () => {
      const result = await handleSaveTailoredResume(
        { jobId: "job-1", resumeText: tailoredResumeText },
        "user-1",
      );

      expect(prisma.resume.create).toHaveBeenCalledWith({
        data: { profileId: "profile-1", title: "Acme Corp – Senior Backend Engineer", FileId: undefined },
        select: { id: true },
      });
      expect(prisma.file.create).not.toHaveBeenCalled();

      expect(prisma.resumeSection.create).toHaveBeenCalledWith({
        data: {
          resumeId: "resume-1",
          sectionTitle: "Tailored Resume",
          sectionType: "summary",
        },
      });
      expect(prisma.resumeSection.update).toHaveBeenCalledWith({
        where: { id: "section-1" },
        data: { summary: { create: { content: tailoredResumeText } } },
      });

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { resumeId: "resume-1" },
      });
      expect(result.content[0].text).toContain("resume-1");
    });
  });

  describe("file path (fileBase64)", () => {
    it("validates, writes the file to disk, creates a File row, and attaches it to the resume with no section", async () => {
      const result = await handleSaveTailoredResume(
        {
          jobId: "job-1",
          fileBase64: validPdfBase64,
          fileName: "jane-doe-resume.pdf",
          mimeType: "application/pdf",
        },
        "user-1",
      );

      expect(writeFile).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenBuf] = (writeFile as any).mock.calls[0];
      expect(String(writtenPath)).toContain("files/resumes");
      expect(Buffer.isBuffer(writtenBuf)).toBe(true);

      expect(prisma.file.create).toHaveBeenCalledWith({
        data: {
          fileName: "jane-doe-resume.pdf",
          filePath: expect.any(String),
          fileType: "resume",
        },
        select: { id: true },
      });

      expect(prisma.resume.create).toHaveBeenCalledWith({
        data: { profileId: "profile-1", title: "Acme Corp – Senior Backend Engineer", FileId: "file-1" },
        select: { id: true },
      });
      expect(prisma.resumeSection.create).not.toHaveBeenCalled();

      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { resumeId: "resume-1" },
      });
      expect(result.content[0].text).toContain("resume-1");
    });

    it("rejects a file whose bytes don't match the declared mimeType", async () => {
      const badBase64 = Buffer.from("not-a-real-pdf-at-all").toString("base64");

      const result = await handleSaveTailoredResume(
        {
          jobId: "job-1",
          fileBase64: badBase64,
          fileName: "resume.pdf",
          mimeType: "application/pdf",
        },
        "user-1",
      );

      expect(result.content[0].text).toContain("magic-byte check");
      expect(writeFile).not.toHaveBeenCalled();
      expect(prisma.resume.create).not.toHaveBeenCalled();
    });

    it("rejects an oversized file", async () => {
      const hugeBuf = Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46]),
        Buffer.alloc(6 * 1024 * 1024, "a"),
      ]);

      const result = await handleSaveTailoredResume(
        {
          jobId: "job-1",
          fileBase64: hugeBuf.toString("base64"),
          fileName: "resume.pdf",
          mimeType: "application/pdf",
        },
        "user-1",
      );

      expect(result.content[0].text).toContain("under");
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  it("uses the supplied title instead of deriving one from the job", async () => {
    await handleSaveTailoredResume(
      { jobId: "job-1", title: "My Custom Title", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(prisma.resume.create).toHaveBeenCalledWith({
      data: { profileId: "profile-1", title: "My Custom Title", FileId: undefined },
      select: { id: true },
    });
  });

  it("appends a counter when the title is already taken", async () => {
    (prisma.resume.findMany as any).mockResolvedValue([
      { title: "Acme Corp – Senior Backend Engineer" },
    ]);

    await handleSaveTailoredResume(
      { jobId: "job-1", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(prisma.resume.create).toHaveBeenCalledWith({
      data: {
        profileId: "profile-1",
        title: "Acme Corp – Senior Backend Engineer (2)",
        FileId: undefined,
      },
      select: { id: true },
    });
  });

  it("creates a profile when the user doesn't have one yet", async () => {
    (prisma.profile.findFirst as any).mockResolvedValue(null);
    (prisma.profile.create as any).mockResolvedValue({ id: "new-profile" });

    await handleSaveTailoredResume(
      { jobId: "job-1", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(prisma.profile.create).toHaveBeenCalledWith({
      data: { userId: "user-1" },
      select: { id: true },
    });
    expect(prisma.resume.create).toHaveBeenCalledWith({
      data: { profileId: "new-profile", title: "Acme Corp – Senior Backend Engineer", FileId: undefined },
      select: { id: true },
    });
  });

  it("returns a not-found message when the job doesn't exist, isn't owned, or wasn't created via MCP", async () => {
    (prisma.job.findFirst as any).mockResolvedValue(null);

    const result = await handleSaveTailoredResume(
      { jobId: "someone-elses-job", resumeText: tailoredResumeText },
      "user-2",
    );

    expect(result.content[0].text).toContain(
      "Job not found, not owned by this token's user, or not eligible for a resume link via MCP.",
    );
    expect(prisma.resume.create).not.toHaveBeenCalled();
  });

  it("returns a rate-limit message and never touches the DB when the limit is exceeded", async () => {
    (checkMcpRateLimit as any).mockReturnValueOnce({ allowed: false, resetIn: 60000 });

    const result = await handleSaveTailoredResume(
      { jobId: "job-1", resumeText: tailoredResumeText },
      "user-3",
    );

    expect(result.content[0].text).toContain("Rate limit exceeded");
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it("surfaces a generic error message on a DB failure", async () => {
    (prisma.resume.create as any).mockRejectedValue(new Error("connection reset"));

    const result = await handleSaveTailoredResume(
      { jobId: "job-1", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(result.content[0].text).toBe("Error: connection reset");
  });
});
