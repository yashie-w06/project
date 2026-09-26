import { z } from "zod";

export const coordinateSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);
export const campusCoordinateSchema = coordinateSchema.refine(
  ([lon, lat]) =>
    lon >= 75.867 && lon <= 75.877 && lat >= 22.722 && lat <= 22.73,
  "Location is outside the campus area",
);
export const profileSchema = z.enum(["healthy", "wheelchair", "heavy_luggage"]);
export const endpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("outdoor"), coordinates: coordinateSchema }),
  z.object({
    kind: z.literal("building"),
    buildingId: z.string().min(1),
    floor: z.number().int(),
    exitDoorId: z.string().min(1).optional(),
    entranceDoorId: z.string().min(1).optional(),
    roomId: z.string().min(1).optional(),
  }),
]);
export const routeRequestSchema = z.object({
  profile: profileSchema,
  start: endpointSchema,
  destination: endpointSchema,
});
export const messageSchema = z.object({
  coordinates: campusCoordinateSchema,
  description: z.string().trim().min(1).max(1000),
});
export const pointSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  coordinates: campusCoordinateSchema,
  published: z.boolean().default(false),
  version: z.number().int().positive().default(1),
});

export type TravelProfile = z.infer<typeof profileSchema>;
