import { createContext } from 'react';
/** The enclosing metric supplies the same verified definition to its total and platform cards. */
export const MarcomVisualContext = createContext<string | undefined>(undefined);
