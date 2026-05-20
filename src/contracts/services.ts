// Service form / YAML manifest contracts. Phase 2 of the FE/BE
// separation (#759) — frontend stops importing `js-yaml` for the
// live editor; validation goes through `POST /api/services/validate-yaml`
// instead.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// POST /api/services/validate-yaml
// ---------------------------------------------------------------------------

export const ValidateYamlRequestSchema = z.object({
  yaml: z.string(),
});

const HumanizedYamlErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  raw: z.string(),
});

// Parsed manifest fields that ServiceForm extracts. Shape mirrors the
// `KubeDoc` interface it used to feed into `extractInfo`. Loose where
// js-yaml is loose — every field is optional so partial / malformed
// inputs still round-trip without losing what *was* parseable.
const KubeVolumeSchema = z
  .object({
    name: z.string().optional(),
    hostPath: z.object({ path: z.string().optional() }).optional(),
    persistentVolumeClaim: z.object({ claimName: z.string().optional() }).optional(),
  })
  .passthrough();

const KubeVolumeMountSchema = z
  .object({
    name: z.string().optional(),
    mountPath: z.string().optional(),
  })
  .passthrough();

const KubePortSchema = z
  .object({
    containerPort: z.number().optional(),
    hostPort: z.number().optional(),
    protocol: z.string().optional(),
  })
  .passthrough();

const KubeContainerSchema = z
  .object({
    name: z.string().optional(),
    image: z.string().optional(),
    ports: z.array(KubePortSchema).optional(),
    volumeMounts: z.array(KubeVolumeMountSchema).optional(),
  })
  .passthrough();

export const KubeDocSchema = z
  .object({
    kind: z.string().optional(),
    metadata: z.object({ name: z.string().optional() }).passthrough().optional(),
    spec: z
      .object({
        containers: z.array(KubeContainerSchema).optional(),
        volumes: z.array(KubeVolumeSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ValidateYamlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), manifest: KubeDocSchema }),
  z.object({ ok: z.literal(false), error: HumanizedYamlErrorSchema }),
]);
