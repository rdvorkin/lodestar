import {toHexString} from "@chainsafe/ssz";
import {
  BLSPubkey,
  Slot,
  BLSSignature,
  allForks,
  isBlindedBeaconBlock,
  ProducedBlockSource,
  deneb,
} from "@lodestar/types";
import {ChainForkConfig} from "@lodestar/config";
import {ForkPreBlobs, ForkBlobs} from "@lodestar/params";
import {extendError, prettyBytes} from "@lodestar/utils";
import {
  Api,
  ApiError,
  isBlockContents,
  isBlindedBlockContents,
  SignedBlindedBlockContents,
  SignedBlockContents,
  routes,
} from "@lodestar/api";
import {IClock, LoggerVc} from "../util/index.js";
import {PubkeyHex} from "../types.js";
import {Metrics} from "../metrics.js";
import {formatBigDecimal} from "../util/format.js";
import {ValidatorStore} from "./validatorStore.js";
import {BlockDutiesService, GENESIS_SLOT} from "./blockDuties.js";

const ETH_TO_WEI = BigInt("1000000000000000000");
// display upto 5 decimal places
const MAX_DECIMAL_FACTOR = BigInt("100000");

/**
 * Cutoff time to wait for execution and builder block production apis to resolve
 * Post this time, race execution and builder to pick whatever resolves first
 *
 * Emprically the builder block resolves in ~1.5+ seconds, and executon should resolve <1 sec.
 * So lowering the cutoff to 2 sec from 3 seconds to publish faster for successful proposal
 * as proposals post 4 seconds into the slot seems to be not being included
 */
// const BLOCK_PRODUCTION_RACE_CUTOFF_MS = 2_000;
// /** Overall timeout for execution and block production apis */
// const BLOCK_PRODUCTION_RACE_TIMEOUT_MS = 12_000;

type FullOrBlindedBlockWithContents =
  | {
      version: ForkPreBlobs;
      block: allForks.BeaconBlock;
      blobs: null;
      executionPayloadBlinded: false;
    }
  | {
      version: ForkBlobs;
      block: allForks.BeaconBlock;
      blobs: deneb.BlobSidecars;
      executionPayloadBlinded: false;
    }
  | {
      version: ForkPreBlobs;
      block: allForks.BlindedBeaconBlock;
      blobs: null;
      executionPayloadBlinded: true;
    }
  | {
      version: ForkBlobs;
      block: allForks.BlindedBeaconBlock;
      blobs: deneb.BlindedBlobSidecars;
      executionPayloadBlinded: true;
    };

/**
 * Service that sets up and handles validator block proposal duties.
 */
export class BlockProposingService {
  private readonly dutiesService: BlockDutiesService;

  constructor(
    private readonly config: ChainForkConfig,
    private readonly logger: LoggerVc,
    private readonly api: Api,
    private readonly clock: IClock,
    private readonly validatorStore: ValidatorStore,
    private readonly metrics: Metrics | null
  ) {
    this.dutiesService = new BlockDutiesService(
      config,
      logger,
      api,
      clock,
      validatorStore,
      metrics,
      this.notifyBlockProductionFn
    );
  }

  removeDutiesForKey(pubkey: PubkeyHex): void {
    this.dutiesService.removeDutiesForKey(pubkey);
  }

  /**
   * `BlockDutiesService` must call this fn to trigger block creation
   * This function may run more than once at a time, rationale in `BlockDutiesService.pollBeaconProposers`
   */
  private notifyBlockProductionFn = (slot: Slot, proposers: BLSPubkey[]): void => {
    if (slot <= GENESIS_SLOT) {
      this.logger.debug("Not producing block before or at genesis slot");
      return;
    }

    if (proposers.length > 1) {
      this.logger.warn("Multiple block proposers", {slot, count: proposers.length});
    }

    Promise.all(proposers.map((pubkey) => this.createAndPublishBlock(pubkey, slot))).catch((e: Error) => {
      this.logger.error("Error on block duties", {slot}, e);
    });
  };

  /** Produce a block at the given slot for pubkey */
  private async createAndPublishBlock(pubkey: BLSPubkey, slot: Slot): Promise<void> {
    const pubkeyHex = toHexString(pubkey);
    const logCtx = {slot, validator: prettyBytes(pubkeyHex)};

    // Wrap with try catch here to re-use `logCtx`
    try {
      const randaoReveal = await this.validatorStore.signRandao(pubkey, slot);
      const graffiti = this.validatorStore.getGraffiti(pubkeyHex);

      const debugLogCtx = {...logCtx, validator: pubkeyHex};

      const strictFeeRecipientCheck = this.validatorStore.strictFeeRecipientCheck(pubkeyHex);
      const builderSelection = this.validatorStore.getBuilderSelection(pubkeyHex);
      const feeRecipient = this.validatorStore.getFeeRecipient(pubkeyHex);

      this.logger.debug("Producing block", {
        ...debugLogCtx,
        builderSelection,
        feeRecipient,
        strictFeeRecipientCheck,
      });
      this.metrics?.proposerStepCallProduceBlock.observe(this.clock.secFromSlot(slot));

      const blockContents = await this.produceBlockWrapper(slot, randaoReveal, graffiti, {
        feeRecipient,
        strictFeeRecipientCheck,
        builderSelection,
      }).catch((e: Error) => {
        this.metrics?.blockProposingErrors.inc({error: "produce"});
        throw extendError(e, "Failed to produce block");
      });

      this.logger.debug("Produced block", {...debugLogCtx, ...blockContents.debugLogCtx});
      this.metrics?.blocksProduced.inc();

      const signedBlockPromise = this.validatorStore.signBlock(pubkey, blockContents.block, slot);
      const signedBlobPromises =
        blockContents.blobs !== null
          ? blockContents.blobs.map((blob) => this.validatorStore.signBlob(pubkey, blob, slot))
          : undefined;
      let signedBlock: allForks.FullOrBlindedSignedBeaconBlock,
        signedBlobs: allForks.FullOrBlindedSignedBlobSidecar[] | undefined;
      if (signedBlobPromises !== undefined) {
        [signedBlock, ...signedBlobs] = await Promise.all([signedBlockPromise, ...signedBlobPromises]);
      } else {
        signedBlock = await signedBlockPromise;
        signedBlobs = undefined;
      }

      await this.publishBlockWrapper(signedBlock, signedBlobs).catch((e: Error) => {
        this.metrics?.blockProposingErrors.inc({error: "publish"});
        throw extendError(e, "Failed to publish block");
      });
      this.metrics?.proposerStepCallPublishBlock.observe(this.clock.secFromSlot(slot));
      this.metrics?.blocksPublished.inc();
      this.logger.info("Published block", {...logCtx, graffiti, ...blockContents.debugLogCtx});
    } catch (e) {
      this.logger.error("Error proposing block", logCtx, e as Error);
    }
  }

  private publishBlockWrapper = async (
    signedBlock: allForks.FullOrBlindedSignedBeaconBlock,
    signedBlobSidecars?: allForks.FullOrBlindedSignedBlobSidecar[]
  ): Promise<void> => {
    if (signedBlobSidecars === undefined) {
      ApiError.assert(
        isBlindedBeaconBlock(signedBlock.message)
          ? await this.api.beacon.publishBlindedBlock(signedBlock as allForks.SignedBlindedBeaconBlock)
          : await this.api.beacon.publishBlock(signedBlock as allForks.SignedBeaconBlock)
      );
    } else {
      ApiError.assert(
        isBlindedBeaconBlock(signedBlock.message)
          ? await this.api.beacon.publishBlindedBlock({
              signedBlindedBlock: signedBlock,
              signedBlindedBlobSidecars: signedBlobSidecars,
            } as SignedBlindedBlockContents)
          : await this.api.beacon.publishBlock({signedBlock, signedBlobSidecars} as SignedBlockContents)
      );
    }
  };

  private produceBlockWrapper = async (
    slot: Slot,
    randaoReveal: BLSSignature,
    graffiti: string,
    {feeRecipient, strictFeeRecipientCheck, builderSelection}: routes.validator.ExtraProduceBlockOps
  ): Promise<FullOrBlindedBlockWithContents & {debugLogCtx: Record<string, string | boolean | undefined>}> => {
    const res = await this.api.validator.produceBlockV3(slot, randaoReveal, graffiti, false, {
      feeRecipient,
      builderSelection,
      strictFeeRecipientCheck,
    });
    ApiError.assert(res, "Failed to produce block: validator.produceBlockV2");
    const {response} = res;

    const debugLogCtx = {
      source: response.executionPayloadBlinded ? ProducedBlockSource.builder : ProducedBlockSource.engine,
      // winston logger doesn't like bigint
      executionPayloadValue: `${formatBigDecimal(response.executionPayloadValue, ETH_TO_WEI, MAX_DECIMAL_FACTOR)} ETH`,
      // TODO PR: should be used in api call instead of adding in log
      strictFeeRecipientCheck,
      builderSelection,
    };

    let fullOrBlindedBlockWithContents: FullOrBlindedBlockWithContents;
    if (response.executionPayloadBlinded) {
      if (isBlindedBlockContents(response.data)) {
        fullOrBlindedBlockWithContents = {
          block: response.data.blindedBlock,
          blobs: response.data.blindedBlobSidecars,
          version: response.version,
          executionPayloadBlinded: true,
        } as FullOrBlindedBlockWithContents;
      } else {
        fullOrBlindedBlockWithContents = {
          block: response.data,
          blobs: null,
          version: response.version,
          executionPayloadBlinded: true,
        } as FullOrBlindedBlockWithContents;
      }
    } else {
      if (isBlockContents(response.data)) {
        fullOrBlindedBlockWithContents = {
          block: response.data.block,
          blobs: response.data.blobSidecars,
          version: response.version,
          executionPayloadBlinded: false,
        } as FullOrBlindedBlockWithContents;
      } else {
        fullOrBlindedBlockWithContents = {
          block: response.data,
          blobs: null,
          version: response.version,
          executionPayloadBlinded: false,
        } as FullOrBlindedBlockWithContents;
      }
    }

    return {...fullOrBlindedBlockWithContents, debugLogCtx};
  };
}
