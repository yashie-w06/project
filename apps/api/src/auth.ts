import argon2 from "argon2";
import type { RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "./config.js";

const encoder = new TextEncoder();

export async function verifyEditorPassword(config: Config, password: string): Promise<boolean> {
  if (config.EDITOR_PASSWORD_HASH) return argon2.verify(config.EDITOR_PASSWORD_HASH, password);
  return password === config.EDITOR_PASSWORD;
}

export async function createEditorToken(config: Config): Promise<string> {
  return new SignJWT({ role: "editor" }).setProtectedHeader({ alg: "HS256" }).setSubject(config.EDITOR_EMAIL)
    .setIssuedAt().setExpirationTime("2h").sign(encoder.encode(config.EDITOR_TOKEN_SECRET));
}

export function requireEditor(config: Config): RequestHandler {
  return async (request, response, next) => {
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return response.status(401).json({ error: "Editor authentication required" });
    try {
      const verified = await jwtVerify(token, encoder.encode(config.EDITOR_TOKEN_SECRET));
      if (verified.payload.role !== "editor") throw new Error("wrong role");
      next();
    } catch {
      response.status(401).json({ error: "Invalid or expired editor token" });
    }
  };
}
