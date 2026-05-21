import { FastifyPluginAsync } from "fastify";
import { prisma } from "../prisma";

export const materialsRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/",
    {
      preHandler: [server.authenticate],
    },
    async () => {
      const materials = await prisma.materials.findMany({
        select: {
          materialId: true,
          materialName: true,
          group: {
            select: {
              groupId: true,
              groupName: true,
            },
          },
        },
        orderBy: {
          materialName: "asc",
        },
      });

      return materials.map((material) => ({
        id: material.materialId.toString(),
        name: material.materialName,
        group: material.group
          ? {
              id: material.group.groupId.toString(),
              name: material.group.groupName,
            }
          : null,
      }));
    },
  );
};
