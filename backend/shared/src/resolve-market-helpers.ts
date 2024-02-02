import * as admin from 'firebase-admin'
import { mapValues, groupBy, sum, sumBy, chunk } from 'lodash'

import {
  HOUSE_LIQUIDITY_PROVIDER_ID,
  DEV_HOUSE_LIQUIDITY_PROVIDER_ID,
} from 'common/antes'
import { Bet } from 'common/bet'
import { getContractBetMetrics } from 'common/calculate'
import { Contract, contractPath, CPMMMultiContract } from 'common/contract'
import { LiquidityProvision } from 'common/liquidity-provision'
import {
  CancelUniqueBettorBonusTxn,
  ContractResolutionPayoutTxn,
  UniqueBettorBonusTxn,
} from 'common/txn'
import { User } from 'common/user'
import { removeUndefinedProps } from 'common/util/object'
import { createContractResolvedNotifications } from './create-notification'
import { updateContractMetricsForUsers } from './helpers/user-contract-metrics'
import { runTxn, insertTxns } from './txn/run-txn'
import {
  revalidateStaticProps,
  isProd,
  checkAndMergePayouts,
  GCPLog,
} from './utils'
import { getLoanPayouts, getPayouts, groupPayoutsByUser } from 'common/payouts'
import { APIError } from 'common//api/utils'
import { ENV_CONFIG } from 'common/envs/constants'
import { FieldValue, Query } from 'firebase-admin/firestore'
import { trackPublicEvent } from 'shared/analytics'
import { recordContractEdit } from 'shared/record-contract-edit'
import { createSupabaseDirectClient } from './supabase/init'
import { Answer } from 'common/answer'

export type ResolutionParams = {
  outcome: string
  probabilityInt?: number
  answerId?: string
  value?: number
  resolutions?: { [key: string]: number }
}

export const resolveMarketHelper = async (
  unresolvedContract: Contract,
  resolver: User,
  creator: User,
  { value, resolutions, probabilityInt, outcome, answerId }: ResolutionParams,
  log: GCPLog
) => {
  const { closeTime, id: contractId } = unresolvedContract

  const resolutionTime = Date.now()
  const newCloseTime = closeTime
    ? Math.min(closeTime, resolutionTime)
    : closeTime

  const {
    creatorPayout,
    collectedFees,
    bets,
    resolutionProbability,
    payouts,
    payoutsWithoutLoans,
  } = await getDataAndPayoutInfo(
    outcome,
    unresolvedContract,
    resolutions,
    probabilityInt,
    answerId
  )

  let updatedAttrs: Partial<Contract> | undefined = removeUndefinedProps({
    isResolved: true,
    resolution: outcome,
    resolutionValue: value,
    resolutionTime,
    closeTime: newCloseTime,
    resolutionProbability,
    resolutions,
    collectedFees,
    resolverId: resolver.id,
    subsidyPool: 0,
  })
  let updateAnswerAttrs: Partial<Answer> | undefined

  if (unresolvedContract.mechanism === 'cpmm-multi-1' && answerId) {
    // Only resolve the contract if all other answers are resolved.
    if (
      unresolvedContract.answers
        .filter((a) => a.id !== answerId)
        .every((a) => a.resolution)
    )
      updatedAttrs = {
        ...updatedAttrs,
        resolution: 'MKT',
      }
    else updatedAttrs = undefined

    const finalProb =
      resolutionProbability ??
      (outcome === 'YES' ? 1 : outcome === 'NO' ? 0 : undefined)
    updateAnswerAttrs = removeUndefinedProps({
      resolution: outcome,
      resolutionTime,
      resolutionProbability,
      prob: finalProb,
      resolverId: resolver.id,
    }) as Partial<Answer>
    // We have to update the denormalized answer data on the contract for the updateContractMetrics call
    updatedAttrs = {
      ...(updatedAttrs ?? {}),
      answers: unresolvedContract.answers.map((a) =>
        a.id === answerId
          ? {
              ...a,
              ...updateAnswerAttrs,
            }
          : a
      ),
    } as Partial<CPMMMultiContract>
  }

  const contract = {
    ...unresolvedContract,
    ...updatedAttrs,
  } as Contract

  // handle exploit where users can get negative payouts
  const negPayoutThreshold = contract.uniqueBettorCount <= 2 ? -500 : -10000

  const userPayouts = groupPayoutsByUser(payouts)
  log('user payouts', { userPayouts })

  const negativePayouts = Object.values(userPayouts).filter(
    (p) => p <= negPayoutThreshold
  )

  log('negative payouts', { negativePayouts })

  if (
    outcome === 'CANCEL' &&
    !ENV_CONFIG.adminIds.includes(resolver.id) &&
    negativePayouts.length > 0
  ) {
    throw new APIError(
      403,
      'Negative payouts too large for resolution. Contact admin.'
    )
  }

  // Should we combine all the payouts into one txn?
  const contractDoc = firestore.doc(`contracts/${contractId}`)

  if (updatedAttrs) {
    log('updating contract', { updatedAttrs })
    await contractDoc.update(updatedAttrs)
    log('contract resolved')
  }
  if (updateAnswerAttrs) {
    const answerDoc = firestore.doc(
      `contracts/${contractId}/answersCpmm/${answerId}`
    )
    await answerDoc.update(removeUndefinedProps(updateAnswerAttrs))
  }
  log('processing payouts', { payouts })
  await payUsersTransactions(log, payouts, contractId, answerId)

  await updateContractMetricsForUsers(contract, bets)
  // TODO: we may want to support clawing back trader bonuses on MC markets too
  if (!answerId) {
    await undoUniqueBettorRewardsIfCancelResolution(contract, outcome, log)
  }
  await revalidateStaticProps(contractPath(contract))

  const userPayoutsWithoutLoans = groupPayoutsByUser(payoutsWithoutLoans)

  const userIdToContractMetrics = mapValues(
    groupBy(bets, (bet) => bet.userId),
    (bets) => getContractBetMetrics(contract, bets)
  )
  await trackPublicEvent(resolver.id, 'resolve market', {
    resolution: outcome,
    contractId,
  })

  await recordContractEdit(
    unresolvedContract,
    resolver.id,
    Object.keys(updatedAttrs ?? {})
  )

  await createContractResolvedNotifications(
    contract,
    resolver,
    creator,
    outcome,
    probabilityInt,
    value,
    answerId,
    {
      userIdToContractMetrics,
      userPayouts: userPayoutsWithoutLoans,
      creatorPayout,
      resolutionProbability,
      resolutions,
    }
  )

  return contract
}

export const getDataAndPayoutInfo = async (
  outcome: string | undefined,
  unresolvedContract: Contract,
  resolutions: { [key: string]: number } | undefined,
  probabilityInt: number | undefined,
  answerId: string | undefined
) => {
  const { id: contractId, creatorId } = unresolvedContract
  const liquiditiesSnap = await firestore
    .collection(`contracts/${contractId}/liquidity`)
    .get()

  const liquidities = liquiditiesSnap.docs.map(
    (doc) => doc.data() as LiquidityProvision
  )

  let bets: Bet[]
  if (
    unresolvedContract.mechanism === 'cpmm-multi-1' &&
    unresolvedContract.shouldAnswersSumToOne
  ) {
    // Load bets from supabase as an optimization.
    // This type of multi choice generates a lot of extra bets that have shares = 0.
    const pg = createSupabaseDirectClient()
    bets = await pg.map(
      `select * from contract_bets
      where contract_id = $1
      and (shares != 0 or (data->>'loanAmount')::numeric != 0)
      `,
      [contractId],
      (row) => row.data
    )
  } else {
    let betsQuery: Query<any> = firestore.collection(
      `contracts/${contractId}/bets`
    )
    if (answerId) {
      betsQuery = betsQuery.where('answerId', '==', answerId)
    }
    const betsSnap = await betsQuery.get()
    bets = betsSnap.docs.map((doc) => doc.data() as Bet)
  }

  const resolutionProbability =
    probabilityInt !== undefined ? probabilityInt / 100 : undefined

  const resolutionProbs = resolutions
    ? (() => {
        const total = sum(Object.values(resolutions))
        return mapValues(resolutions, (p) => p / total)
      })()
    : undefined
  const openBets = bets.filter((b) => !b.isSold && !b.sale)
  const loanPayouts = getLoanPayouts(openBets)

  const {
    payouts: traderPayouts,
    creatorPayout,
    liquidityPayouts,
    collectedFees,
  } = getPayouts(
    outcome,
    unresolvedContract,
    bets,
    liquidities,
    resolutionProbs,
    resolutionProbability,
    answerId
  )
  const payoutsWithoutLoans = [
    { userId: creatorId, payout: creatorPayout, deposit: creatorPayout },
    ...liquidityPayouts.map((p) => ({ ...p, deposit: p.payout })),
    ...traderPayouts,
  ]
  if (!isProd())
    console.log(
      'trader payouts:',
      traderPayouts,
      'creator payout:',
      creatorPayout,
      'liquidity payout:',
      liquidityPayouts,
      'loan payouts:',
      loanPayouts
    )
  const payouts = [...payoutsWithoutLoans, ...loanPayouts]
  return {
    payoutsWithoutLoans,
    creatorPayout,
    collectedFees,
    bets,
    resolutionProbability,
    payouts,
  }
}
async function undoUniqueBettorRewardsIfCancelResolution(
  contract: Contract,
  outcome: string,
  log: GCPLog
) {
  if (outcome === 'CANCEL') {
    const pg = createSupabaseDirectClient()

    const txn = await pg.tx(async (tx) => {
      // TODO: bonuses for contractId should be sufficient, no need for toId
      const bettorBonusTxnsOnThisContract = await tx.map<UniqueBettorBonusTxn>(
        `select data from txns
      where category = 'UNIQUE_BETTOR_BONUS'
      and data->>'contractId' = $2`,
        [contract.id],
        (res) => res.data
      )

      log(
        'total bonusTxnsOnThisContract ' + bettorBonusTxnsOnThisContract.length
      )
      const totalBonusAmount = sumBy(
        bettorBonusTxnsOnThisContract,
        (txn) => txn.amount
      )
      log('totalBonusAmount to be withdrawn ' + totalBonusAmount)

      const bonusTxn = {
        fromId: contract.creatorId,
        fromType: 'USER',
        toId: isProd()
          ? HOUSE_LIQUIDITY_PROVIDER_ID
          : DEV_HOUSE_LIQUIDITY_PROVIDER_ID,
        toType: 'BANK',
        amount: totalBonusAmount,
        token: 'M$',
        category: 'CANCEL_UNIQUE_BETTOR_BONUS',
        data: {
          contractId: contract.id,
        },
      } as Omit<CancelUniqueBettorBonusTxn, 'id' | 'createdTime'>
      return await runTxn(tx, bonusTxn)
    })

    log(`Cancel Bonus txn for user: ${contract.creatorId} completed: ${txn.id}`)
  }
}

export const payUsersTransactions = async (
  log: GCPLog,
  payouts: {
    userId: string
    payout: number
    deposit?: number
  }[],
  contractId: string,
  answerId?: string
) => {
  const firestore = admin.firestore()
  const pg = createSupabaseDirectClient()
  const mergedPayouts = checkAndMergePayouts(payouts)
  const payoutChunks = chunk(mergedPayouts, 250)
  const payoutStartTime = Date.now()

  for (const payoutChunk of payoutChunks) {
    const txns: Omit<ContractResolutionPayoutTxn, 'id' | 'createdTime'>[] =
      payoutChunk.map(({ userId, payout, deposit }) => ({
        category: 'CONTRACT_RESOLUTION_PAYOUT',
        fromType: 'CONTRACT',
        fromId: contractId,
        toType: 'USER',
        toId: userId,
        amount: payout,
        token: 'M$',
        data: removeUndefinedProps({
          deposit: deposit ?? 0,
          payoutStartTime,
          answerId,
        }),
        description: 'Contract payout for resolution: ' + contractId,
      }))

    await pg
      .tx(async (tx) => {
        insertTxns(tx, ...txns)

        await firestore.runTransaction(async (transaction) => {
          payoutChunk.forEach(({ userId, payout, deposit }) => {
            const toDoc = firestore.doc(`users/${userId}`)
            transaction.update(toDoc, {
              balance: FieldValue.increment(payout),
              totalDeposits: FieldValue.increment(deposit ?? 0),
            })
          })
        }) // end firestore transaction
      }) // end pg.tx
      .catch((err) => {
        log('Error running payout chunk transaction', err)
        log('payoutChunk', payoutChunk)
        // don't rethrow error without undoing previous payouts
      })
  }
}

const firestore = admin.firestore()
