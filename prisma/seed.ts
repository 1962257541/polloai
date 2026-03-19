import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@polloai.com";
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash("admin123456", 10);
  const admin = await prisma.user.create({
    data: {
      email,
      name: "Admin",
      passwordHash,
      role: "admin",
    },
  });

  console.log(`Created admin user: ${admin.email} (id: ${admin.id})`);
  console.log("Credentials: admin@polloai.com / admin123456");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
