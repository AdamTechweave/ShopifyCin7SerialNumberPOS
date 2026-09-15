import { flatRoutes } from "@react-router/fs-routes";

// Colocated route tests must be excluded, or flatRoutes treats them as route
// modules. A route test necessarily imports the server-only modules its route
// imports, and React Router's server-code splitting then fails the build with
// "other route exports depend on '../services/cin7.server'". Vitest still picks
// them up — its include globs are independent of routing.
export default flatRoutes({ ignoredRouteFiles: ["**/*.test.*"] });
