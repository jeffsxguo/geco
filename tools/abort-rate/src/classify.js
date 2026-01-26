function classifyFabricError(error) {
  const raw = error && (error.details ?? error.message ?? error);
  const message = String(raw ?? '');

  const upper = message.toUpperCase();
  if (upper.includes('MVCC_READ_CONFLICT')) return { abortReason: 'abort_mvcc', fabricStatus: 'MVCC_READ_CONFLICT' };

  if (
    upper.includes('ENDORSEMENT_POLICY_FAILURE') ||
    upper.includes('FAILED TO ENDORSE') ||
    upper.includes('CHAINCODE_ENDORSEMENT_FAILED') ||
    upper.includes('NO VALID RESPONSES') ||
    upper.includes('ENDORSEMENT')
  ) {
    return { abortReason: 'abort_endorsement', fabricStatus: 'ENDORSEMENT' };
  }

  if (upper.includes('DEADLINE_EXCEEDED') || upper.includes('TIMEOUT')) return { abortReason: 'abort_timeout', fabricStatus: 'TIMEOUT' };

  if (upper.includes('UNAVAILABLE') || upper.includes('RST_STREAM') || upper.includes('GRPC')) return { abortReason: 'abort_gateway', fabricStatus: 'GATEWAY' };

  return { abortReason: 'abort_unknown', fabricStatus: '' };
}

function classifyCommitStatus(status) {
  if (!status) return { abortReason: 'abort_unknown', fabricStatus: '' };
  const code = status.code ?? status.status ?? status.validationCode;
  if (typeof code === 'number') {
    if (code === 0) return { abortReason: '', fabricStatus: 'VALID' };
    if (code === 11) return { abortReason: 'abort_mvcc', fabricStatus: 'MVCC_READ_CONFLICT' };
    if (code === 12) return { abortReason: 'abort_mvcc', fabricStatus: 'PHANTOM_READ_CONFLICT' };
    return { abortReason: 'abort_unknown', fabricStatus: `CODE_${code}` };
  }

  const name = typeof code === 'string' ? code : String(code);
  const upper = name.toUpperCase();
  if (upper.includes('MVCC_READ_CONFLICT') || upper.includes('PHANTOM_READ_CONFLICT')) {
    return { abortReason: 'abort_mvcc', fabricStatus: name };
  }
  if (upper.includes('VALID')) return { abortReason: '', fabricStatus: name };
  return { abortReason: 'abort_unknown', fabricStatus: name };
}

module.exports = { classifyFabricError, classifyCommitStatus };
