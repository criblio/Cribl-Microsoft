// CORE-LOCAL, not a kit copy: the metrics kit's './transport' imports resolve to the one
// clock-free transport in ../config-writes/transport (see the header there). The kit's own
// metrics transport is not copied because its systemClock breaks core purity.
export * from '../config-writes/transport';
