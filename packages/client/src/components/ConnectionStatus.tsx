import { useConnectionStore } from '../stores/connectionStore';

export const ConnectionStatus = () => {
    const gatewayStatus = useConnectionStore((s) => s.gatewayStatus);
    const metrics = useConnectionStore((s) => s.metrics);

    const getStatusColor = () => {
        switch (gatewayStatus) {
            case 'connected':
                return metrics.latency < 100 ? 'bg-green-500' : 'bg-yellow-500';
            case 'reconnecting':
                return 'bg-yellow-500';
            case 'disconnected':
                return 'bg-red-500';
            default:
                return 'bg-gray-500';
        }
    };

    const getStatusText = () => {
        switch (gatewayStatus) {
            case 'connected':
                return metrics.latency > 0 ? `${metrics.latency}ms` : 'Connected';
            case 'reconnecting':
                return 'Reconnecting...';
            case 'disconnected':
                return 'Disconnected';
            default:
                return 'Unknown';
        }
    };

    return (
        <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
            <span className="text-text-secondary">{getStatusText()}</span>
        </div>
    );
};