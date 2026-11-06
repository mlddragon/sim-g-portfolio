/**
 * The composition root is introduced after the domain and port contracts.
 * Exporting a version here keeps the foundation build executable without
 * prematurely coupling the core to Fastify or any provider SDK.
 */
export const gatewayVersion = '0.1.0' as const;
