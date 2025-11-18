import { FastifyPluginAsync } from "fastify";
import { prisma } from "../prisma";

export const materialsRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/",
    {
      preHandler: [server.authenticate]
    },
    async () => {
      const materials = await prisma.materials.findMany({
        select: {
          materialId: true,
          materialName: true
        },
        orderBy: {
          materialName: "asc"
        }
      });

      return materials.map((material) => ({
        id: material.materialId.toString(),
        name: material.materialName
      }));
    }
  );
};


