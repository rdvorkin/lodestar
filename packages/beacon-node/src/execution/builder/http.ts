import {byteArrayEquals, toHexString} from "@chainsafe/ssz";
import {allForks, bellatrix, Slot, Root, BLSPubkey, ssz, deneb, Wei} from "@lodestar/types";
import {ChainForkConfig} from "@lodestar/config";
import {getClient, Api as BuilderApi} from "@lodestar/api/builder";
import {SLOTS_PER_EPOCH, ForkExecution} from "@lodestar/params";
import {
  SignedBlockContents,
  SignedBlindedBlockContents,
  isExecutionPayloadAndBlobsBundle,
  isSignedBlindedBlockContents,
} from "@lodestar/api";

import {ApiError} from "@lodestar/api";
import {Metrics} from "../../metrics/metrics.js";
import {IExecutionBuilder} from "./interface.js";

export type ExecutionBuilderHttpOpts = {
  enabled: boolean;
  urls: string[];
  timeout?: number;
  faultInspectionWindow?: number;
  allowedFaults?: number;

  // Only required for merge-mock runs, no need to expose it to cli
  issueLocalFcUWithFeeRecipient?: string;
  // Add User-Agent header to all requests
  userAgent?: string;
};

export const defaultExecutionBuilderHttpOpts: ExecutionBuilderHttpOpts = {
  enabled: false,
  urls: ["http://localhost:8661"],
  timeout: 12000,
};

export class ExecutionBuilderHttp implements IExecutionBuilder {
  readonly api: BuilderApi;
  readonly config: ChainForkConfig;
  readonly issueLocalFcUWithFeeRecipient?: string;
  // Builder needs to be explicity enabled using updateStatus
  status = false;
  faultInspectionWindow: number;
  allowedFaults: number;

  constructor(opts: ExecutionBuilderHttpOpts, config: ChainForkConfig, metrics: Metrics | null = null) {
    const baseUrl = opts.urls[0];
    if (!baseUrl) throw Error("No Url provided for executionBuilder");
    this.api = getClient(
      {
        baseUrl,
        timeoutMs: opts.timeout,
        extraHeaders: opts.userAgent ? {"User-Agent": opts.userAgent} : undefined,
      },
      {config, metrics: metrics?.builderHttpClient}
    );
    this.config = config;
    this.issueLocalFcUWithFeeRecipient = opts.issueLocalFcUWithFeeRecipient;

    /**
     * Beacon clients select randomized values from the following ranges when initializing
     * the circuit breaker (so at boot time and once for each unique boot).
     *
     * ALLOWED_FAULTS: between 1 and SLOTS_PER_EPOCH // 2
     * FAULT_INSPECTION_WINDOW: between SLOTS_PER_EPOCH and 2 * SLOTS_PER_EPOCH
     *
     */
    this.faultInspectionWindow = Math.max(
      opts.faultInspectionWindow ?? SLOTS_PER_EPOCH + Math.floor(Math.random() * SLOTS_PER_EPOCH),
      SLOTS_PER_EPOCH
    );
    // allowedFaults should be < faultInspectionWindow, limiting them to faultInspectionWindow/2
    this.allowedFaults = Math.min(
      opts.allowedFaults ?? Math.floor(this.faultInspectionWindow / 2),
      Math.floor(this.faultInspectionWindow / 2)
    );
  }

  updateStatus(shouldEnable: boolean): void {
    this.status = shouldEnable;
  }

  async checkStatus(): Promise<void> {
    try {
      await this.api.status();
    } catch (e) {
      // Disable if the status was enabled
      this.status = false;
      throw e;
    }
  }

  async registerValidator(registrations: bellatrix.SignedValidatorRegistrationV1[]): Promise<void> {
    ApiError.assert(await this.api.registerValidator(registrations));
  }

  async getHeader(
    fork: ForkExecution,
    slot: Slot,
    parentHash: Root,
    proposerPubKey: BLSPubkey
  ): Promise<{
    header: allForks.ExecutionPayloadHeader;
    executionPayloadValue: Wei;
    blindedBlobsBundle?: deneb.BlindedBlobsBundle;
  }> {
    const res = await this.api.getHeader(slot, parentHash, proposerPubKey);
    ApiError.assert(res, "execution.builder.getheader");
    const {header, value: executionPayloadValue} = res.response.data.message;
    const {blindedBlobsBundle} = res.response.data.message as deneb.BuilderBid;
    return {header, executionPayloadValue, blindedBlobsBundle};
  }

  async submitBlindedBlock(
    signedBlindedBlockOrContents: allForks.SignedBlindedBeaconBlock | SignedBlindedBlockContents
  ): Promise<allForks.SignedBeaconBlock | SignedBlockContents> {
    const res = await this.api.submitBlindedBlock(signedBlindedBlockOrContents);
    ApiError.assert(res, "execution.builder.submitBlindedBlock");
    const {data} = res.response;

    let executionPayload: allForks.ExecutionPayload;
    let blobsBundle: deneb.BlobsBundle | null;

    if (isExecutionPayloadAndBlobsBundle(data)) {
      executionPayload = data.executionPayload;
      blobsBundle = data.blobsBundle;
    } else {
      executionPayload = data;
      blobsBundle = null;
    }

    let signedBlindedBlock: allForks.SignedBlindedBeaconBlock;
    let signedBlindedBlobSidecars: deneb.SignedBlindedBlobSidecars | null;
    if (isSignedBlindedBlockContents(signedBlindedBlockOrContents)) {
      signedBlindedBlock = signedBlindedBlockOrContents.signedBlindedBlock;
      signedBlindedBlobSidecars = signedBlindedBlockOrContents.signedBlindedBlobSidecars;
    } else {
      signedBlindedBlock = signedBlindedBlockOrContents;
      signedBlindedBlobSidecars = null;
    }

    // some validations for execution payload
    const expectedTransactionsRoot = signedBlindedBlock.message.body.executionPayloadHeader.transactionsRoot;
    const actualTransactionsRoot = ssz.bellatrix.Transactions.hashTreeRoot(executionPayload.transactions);
    if (!byteArrayEquals(expectedTransactionsRoot, actualTransactionsRoot)) {
      throw Error(
        `Invalid transactionsRoot of the builder payload, expected=${toHexString(
          expectedTransactionsRoot
        )}, actual=${toHexString(actualTransactionsRoot)}`
      );
    }

    const signedBlock: bellatrix.SignedBeaconBlock = {
      ...signedBlindedBlock,
      message: {...signedBlindedBlock.message, body: {...signedBlindedBlock.message.body, executionPayload}},
    };

    if (signedBlindedBlobSidecars !== null) {
      if (blobsBundle === null) {
        throw Error("Invalid Builder response with missing blobsBundle for deneb+ forks");
      }
      if (signedBlindedBlobSidecars.length !== blobsBundle.blobs.length) {
        throw Error(
          `Invalid number of blobs returned by builder, expected=$${signedBlindedBlobSidecars.length} received=${blobsBundle.blobs.length}`
        );
      }
      const signedBlobSidecars = signedBlindedBlobSidecars.map((_v, i) => {
        // signedBlindedBlobSidecars and blobsBundle can't be null as we checked above but
        // typescript can't seem to figure that out
        if (signedBlindedBlobSidecars === null || blobsBundle === null) {
          throw Error("Internal Error - signedBlindedBlobSidecars or blobsBundle is null");
        }

        const signedBlindedBlobSidecar = signedBlindedBlobSidecars[i];
        const blob = blobsBundle.blobs[i];
        return {signature: signedBlindedBlobSidecar.signature, message: {...signedBlindedBlobSidecar.message, blob}};
      });
      return {signedBlock, signedBlobSidecars};
    } else {
      if (blobsBundle !== null) {
        throw Error("Invalid Builder response with blobsBundle for deneb- forks");
      }
      return signedBlock;
    }
  }
}
