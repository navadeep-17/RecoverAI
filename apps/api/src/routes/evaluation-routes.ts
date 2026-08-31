import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FastifyPluginAsync } from 'fastify';
import { requirePrincipal } from '../auth/principal.js';

const artifactPath = path.resolve(process.cwd(), 'packages/evaluation/results/heldout-summary.json');
const FINGERPRINT = 'sha256:f07508e41e4c7a29a1a3c09b2206fa5d7c8cb2dca20a75de9d59e927f8bb8e96';
const CHECKPOINT = 'f599312bd1e81ea4f9d4d9fc3d2acd880b2d9849';

export const evaluationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req, reply) => {
    try {
      requirePrincipal(req);
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { benchmarkLabel: string; seed: number; split: string; results: unknown[] };
      return reply.send({
        frozen: true, artifact: 'packages/evaluation/results/heldout-summary.json', evaluatedAt: null,
        evaluatorFingerprint: FINGERPRINT, approvedCheckpoint: CHECKPOINT, scenarioCount: 500,
        benchmarkLabel: artifact.benchmarkLabel, seed: artifact.seed, split: artifact.split, results: artifact.results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Evaluation snapshot unavailable';
      return reply.status(message.startsWith('UNAUTHORIZED') ? 401 : 500).send({ error: message });
    }
  });
};
