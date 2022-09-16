import { usePrefetchUserBetContracts } from './use-contracts'
import { usePrefetchPortfolioHistory } from './use-portfolio-history'
import { usePrefetchProbChanges } from './use-prob-changes'
import { usePrefetchUserBets } from './use-user-bets'

export function usePrefetch(userId: string | undefined) {
  const maybeUserId = userId ?? ''
  return Promise.all([
    usePrefetchUserBets(maybeUserId),
    usePrefetchUserBetContracts(maybeUserId),
    usePrefetchPortfolioHistory(maybeUserId, 'weekly'),
    usePrefetchProbChanges(userId),
  ])
}
