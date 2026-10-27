import { Context, Service } from "@deepseek-ai/cordis";

//#region src/types.d.ts
/**
 * Carrier-independent Typert Gateway request, service, and error contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */
/** One Remote method request after a carrier has decoded its envelope. */
interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  readonly namespace: string;
  /** Exported Service method name. */
  readonly method: string;
  /** Named wire values; fields must exactly match the descriptor. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  readonly signal?: AbortSignal;
}
/** Stable infrastructure and boundary failures emitted before or after business execution. */
type TypertGatewayErrorCode = 'ambiguous-endpoint' | 'arguments-invalid' | 'binding-invalid' | 'context-failed' | 'context-not-found' | 'context-unavailable' | 'definition-unavailable' | 'input-invalid' | 'invocation-unavailable' | 'lookup-failed' | 'lookup-not-found' | 'lookup-unavailable' | 'method-unavailable' | 'provider-mismatch' | 'result-invalid' | 'service-unavailable' | 'signature-invalid';
/** Host dispatcher consumed by Connection adapters. */
interface TypertGateway {
  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the validated business result.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host dispatcher for Typert Remote calls. */
    typertGateway: TypertGateway;
  }
} //# sourceMappingURL=types.d.ts.map
//#endregion
//#region src/index.d.ts
interface GatewayErrorOptions {
  readonly cause?: unknown;
  readonly field?: string;
}
/** Dispatch failure produced outside the invoked business method. */
declare class TypertGatewayError extends Error {
  /** Machine-readable failure category. */
  readonly code: TypertGatewayErrorCode;
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string;
  /** Affected wire field when the failure is field-specific. */
  readonly field: string | undefined;
  /**
   * Construct a Gateway failure without embedding boundary values in its message.
   * @param code - stable failure category.
   * @param endpoint - canonical Remote endpoint.
   * @param message - correction-oriented diagnostic without sensitive values.
   * @param options - optional field and contained cause.
   */
  constructor(code: TypertGatewayErrorCode, endpoint: string, message: string, options?: GatewayErrorOptions);
}
/**
 * Resolve strict generated definitions or conservative SRC markers against
 * current Cordis Services and Typert providers.
 * @typert service typertGateway
 */
declare class TypertGatewayService extends Service implements TypertGateway {
  static inject: string[];
  private srcClaims;
  /**
   * Register the Gateway against the active Typert registry.
   * @param ctx - owning Host Context with Typert registry access.
   */
  constructor(ctx: Context);
  private claimsEndpoint;
  private collectSrcClaims;
  /**
   * Invoke one live Remote method through strict generated reflection or SRC markers.
   * @param request - decoded endpoint and exact named wire arguments.
   * @returns the validated business result.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>;
  private dispatchRpc;
  private invokeRpc;
  private resolveDescriptor;
  private resolveSrcDescriptor;
  private srcDescriptor;
  private resolveReceiverContext;
  private resolveParameter;
}
//#endregion
export { type InvokeRemoteRequest, type TypertGateway, TypertGatewayError, type TypertGatewayErrorCode, TypertGatewayService, TypertGatewayService as default };