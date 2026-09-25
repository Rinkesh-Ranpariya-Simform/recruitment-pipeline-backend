-- CreateTable
CREATE TABLE "CandidateProfile" (
    "userId" INTEGER NOT NULL,
    "phone" TEXT,
    "location" TEXT,
    "headline" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
