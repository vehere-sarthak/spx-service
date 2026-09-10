import { Router } from 'express';
import { HealthRoutes } from '../routes/HealthRoutes';
import { SystemRoutes } from '../routes/SystemRoutes';

import AboutRoutes from '../routes/AboutRoutes';
import RolesRoutes from '../routes/RolesRoutes';
import UsersRoutes from '../routes/UsersRoutes';
import AuthLoginRoutes from '../routes/AuthLoginRoutes';
import AuthSessionRoutes from '../routes/AuthSessionRoutes';
import PiiRevealRoutes from '../routes/PiiRevealRoutes';
import AlertsActionsRoutes from '../routes/AlertsActionsRoutes';
import AlertsSummaryRoutes from '../routes/AlertsSummaryRoutes';
import AlertsReconstructionRoutes from '../routes/AlertsReconstructionRoutes';
import AlertsReconstructionPcapRoutes from '../routes/AlertsReconstructionPcapRoutes';
import HealthBandwidthRoutes from '../routes/HealthBandwidthRoutes';
import CaptureinputidentificationRoutes from '../routes/CaptureinputidentificationRoutes';
import LinkmonitoringBulkimportpblinksRoutes from '../routes/LinkmonitoringBulkimportpblinksRoutes';
import DashboardCmsSoiOverviewRoutes from '../routes/DashboardCmsSoiOverviewRoutes';
import SpxmanagementRoutes from '../routes/SpxmanagementRoutes';
import SpxActionRoutes from '../routes/SpxActionRoutes';
import TargetmanagementsRoutes from '../routes/TargetmanagementsRoutes';
import TargetSubRoutes from '../routes/TargetSubRoutes';
import NdrFabricRoutes from '../routes/NdrFabricRoutes';
import CatchAllRoutes from '../routes/CatchAllRoutes';

/**
 * Mount order matters: specific paths first, the ported catch-all last, exactly
 * as Next resolved static segments before [...path].
 */
class AppRoutesProvider {
  public get routes(): Router {
    const router = Router();

    router.use('/health', HealthRoutes);
    router.use('/system', SystemRoutes);

    router.use('/about', AboutRoutes);
    router.use('/roles', RolesRoutes);
    router.use('/users', UsersRoutes);
    router.use('/auth/login', AuthLoginRoutes);
    router.use('/auth/session', AuthSessionRoutes);
    router.use('/pii/reveal', PiiRevealRoutes);

    router.use('/alerts/actions', AlertsActionsRoutes);
    router.use('/alerts/summary', AlertsSummaryRoutes);
    router.use('/alerts/reconstruction/pcap', AlertsReconstructionPcapRoutes);
    router.use('/alerts/reconstruction', AlertsReconstructionRoutes);

    router.use('/health/bandwidth', HealthBandwidthRoutes);
    router.use('/capture-input-identification', CaptureinputidentificationRoutes);
    router.use('/link-monitoring/bulk-import-pb-links', LinkmonitoringBulkimportpblinksRoutes);
    router.use('/dashboard/cms/soi/overview', DashboardCmsSoiOverviewRoutes);

    router.use('/ndr/fabric', NdrFabricRoutes);

    router.use('/spx-management/:id', SpxActionRoutes);
    router.use('/spx-management', SpxmanagementRoutes);
    // exact `/` list+create first; the sub-path catch-all only sees what falls through
    router.use('/target-managements', TargetmanagementsRoutes);
    router.use('/target-managements', TargetSubRoutes);

    // Everything Next served from [...path]
    router.use('/', CatchAllRoutes);

    return router;
  }
}

export const AppRoutes = new AppRoutesProvider();
