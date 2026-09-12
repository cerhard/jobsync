import { handleSaveTailoredResume } from "@/lib/mcp/tools/saveTailoredResume";
import { checkMcpRateLimit } from "@/lib/mcp/rate-limit";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

vi.mock("@prisma/client", () => {
  const mPrismaClient = {
    job: { findFirst: vi.fn(), update: vi.fn() },
    resume: { findMany: vi.fn(), create: vi.fn() },
    resumeSection: { create: vi.fn(), update: vi.fn() },
    profile: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(mPrismaClient)),
  };
  return { PrismaClient: vi.fn(function () { return mPrismaClient; }) };
});

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkMcpRateLimit: vi.fn(() => ({ allowed: true, resetIn: 0 })),
}));

const tailoredResumeText =
  "A".repeat(210) + "\n\nJane Doe\nSenior Backend Engineer\n...";

const jobRow = {
  id: "job-1",
  JobTitle: { label: "Senior Backend Engineer" },
  Company: { label: "Acme Corp" },
};

describe("handleSaveTailoredResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.job.findFirst as any).mockResolvedValue(jobRow);
    (prisma.resume.findMany as any).mockResolvedValue([]);
    (prisma.profile.findFirst as any).mockResolvedValue({ id: "profile-1" });
    (prisma.resume.create as any).mockResolvedValue({ id: "resume-1" });
    (prisma.resumeSection.create as any).mockResolvedValue({ id: "section-1" });
    (prisma.resumeSection.update as any).mockResolvedValue({});
    (prisma.job.update as any).mockResolvedValue({});
  });

  it("creates a resume, a summary section with the tailored text, and links it to the job", async () => {
    const result = await handleSaveTailoredResume(
      { jobId: "job-1", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(prisma.job.findFirst).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1", createdVia: { not: null } },
      select: expect.any(Object),
    });

    expect(prisma.resume.create).toHaveBeenCalledWith({
      data: { profileId: "profile-1", title: "Acme Corp – Senior Backend Engineer" },
      select: { id: true },
    });

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

    expect(result.content[0].text).toContain("Acme Corp – Senior Backend Engineer");
    expect(result.content[0].text).toContain("resume-1");
    expect(result.content[0].text).toContain("job-1");
  });

  it("uses the supplied title instead of deriving one from the job", async () => {
    await handleSaveTailoredResume(
      { jobId: "job-1", title: "My Custom Title", resumeText: tailoredResumeText },
      "user-1",
    );

    expect(prisma.resume.create).toHaveBeenCalledWith({
      data: { profileId: "profile-1", title: "My Custom Title" },
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
      data: { profileId: "new-profile", title: "Acme Corp – Senior Backend Engineer" },
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
