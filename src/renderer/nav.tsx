import { createContext, useContext } from 'react';

/** 画面の行き先。 */
export type Route =
  | { screen: 'home' }
  | { screen: 'projectNew' }
  | { screen: 'projectEdit'; projectId: string }
  | { screen: 'dashboard'; projectId: string }
  | { screen: 'subject'; projectId: string; subjectId: string; tab?: string }
  | { screen: 'import'; projectId: string; subjectId?: string; testId?: string }
  | { screen: 'correction'; projectId: string; subjectId: string; sourceId: string }
  | { screen: 'take'; projectId: string; subjectId: string; testId: string }
  | { screen: 'result'; projectId: string; subjectId: string; testId: string }
  | { screen: 'chat'; projectId: string; subjectId: string; chatId?: string; testId?: string; problemId?: string; unitId?: string }
  | { screen: 'chapter'; projectId: string; subjectId: string; unitId: string }
  | { screen: 'plan'; projectId: string }
  | { screen: 'jobs'; projectId?: string }
  | { screen: 'settings'; projectId?: string };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
  back: () => void;
}

export const NavContext = createContext<Nav>({ route: { screen: 'home' }, go: () => {}, back: () => {} });

export function useNav(): Nav {
  return useContext(NavContext);
}

export function routeProjectId(route: Route): string | undefined {
  return 'projectId' in route ? route.projectId : undefined;
}
