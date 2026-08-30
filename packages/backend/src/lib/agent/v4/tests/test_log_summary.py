import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr

# Import the agent module the same way test_agent.py does.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402

# Obvious placeholders — never a real credential in a committed fixture.
FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET'
FAKE_QUADLET = (
    '[Container]\n'
    'Image=ghcr.io/example/app:1\n'
    'Environment=SSO_CLIENT_SECRET=' + FAKE_SECRET + '\n'
)


def _container_record(i):
    """One container in the shape the state sync actually ships.

    The OCI label block, ports and mounts are what make a real `containers`
    message ~46 KB on the box — the payload #2676 measured.
    """
    return {
        'id': str(i).zfill(2) * 32,
        'names': ['svc%d-app' % i],
        'image': 'ghcr.io/example/app-%d:1.2.3' % i,
        'state': 'running',
        'command': ['/init', '--config', '/config/app-%d.yaml' % i],
        'ports': [
            {'host_ip': '0.0.0.0', 'container_port': 8080, 'host_port': 18080 + i, 'protocol': 'tcp'},
            {'host_ip': '::', 'container_port': 8443, 'host_port': 18443 + i, 'protocol': 'tcp'},
        ],
        'mounts': [
            {'Type': 'bind', 'Source': '/var/mnt/data/app-%d/config' % i, 'Destination': '/config', 'RW': True},
            {'Type': 'bind', 'Source': '/var/mnt/data/app-%d/media' % i, 'Destination': '/media', 'RW': False},
        ],
        'labels': {
            'org.opencontainers.image.description':
                '[App %d](http://example.invalid/app-%d) is a long-winded upstream description '
                'that upstream ships as an OCI label and that rode along verbatim in every '
                'single state sync.' % (i, i),
            'org.opencontainers.image.source': 'https://github.com/example/app-%d' % i,
            'org.opencontainers.image.title': 'App %d' % i,
            'org.opencontainers.image.url': 'https://example.invalid/app-%d/overview.html' % i,
            'org.opencontainers.image.version': 'v1.2.%d' % i,
            'servicebay.role': 'app',
        },
        'networks': [],
        'podName': 'svc%d' % i,
        'pid': 594139 + i,
    }


def _containers_payload(count):
    return {'containers': [_container_record(i) for i in range(count)]}


class TestSummarizeStateForLog(unittest.TestCase):
    def test_cuts_a_realistic_container_sync_by_over_90_percent(self):
        payload = _containers_payload(24)
        before = len(json.dumps(payload))
        after = len(json.dumps(agent._summarize_state_for_log(payload)))
        self.assertGreater(before, 20000)
        self.assertLess(after, before * 0.05)
        self.assertLess(after, 1000)

    def test_keeps_the_count_and_who_was_covered(self):
        out = agent._summarize_state_for_log(_containers_payload(3))
        self.assertEqual(out['containers'], {
            'count': 3,
            'items': ['svc0-app', 'svc1-app', 'svc2-app'],
        })

    def test_drops_the_oci_label_block(self):
        rendered = json.dumps(agent._summarize_state_for_log(_containers_payload(4)))
        self.assertNotIn('org.opencontainers.image', rendered)
        self.assertNotIn('/var/mnt/data', rendered)

    def test_reports_a_remainder_instead_of_every_record(self):
        out = agent._summarize_state_for_log(_containers_payload(40))
        self.assertEqual(out['containers']['count'], 40)
        self.assertEqual(len(out['containers']['items']), 25)
        self.assertEqual(out['containers']['omitted'], 15)

    def test_names_each_record_by_the_key_that_payload_uses(self):
        out = agent._summarize_state_for_log({
            'services': [{'name': 'adguard', 'id': 'adguard', 'activeState': 'active'}],
            'volumes': [{'Name': 'v0', 'Driver': 'local', 'Mountpoint': '/var/mnt/x'}],
            'proxyRoutes': [{'host': 'admin.example.invalid', 'targetPort': 5888}],
            'anonymous': [{'activeState': 'active'}],
        })
        self.assertEqual(out['services']['items'], ['adguard'])
        self.assertEqual(out['volumes']['items'], ['v0'])
        self.assertEqual(out['proxyRoutes']['items'], ['admin.example.invalid'])
        self.assertEqual(out['anonymous']['items'], ['<unnamed>'])

    def test_scalars_pass_through(self):
        self.assertEqual(
            agent._summarize_state_for_log({'initialSyncComplete': True}),
            {'initialSyncComplete': True},
        )

    def test_is_idempotent_because_both_sinks_summarise(self):
        once = agent._summarize_state_for_log({'containers': [{'names': ['a']}, {'names': ['b']}]})
        self.assertEqual(once, {'containers': {'count': 2, 'items': ['a', 'b']}})
        self.assertEqual(agent._summarize_state_for_log(once), once)

    def test_terminates_on_a_pathologically_deep_payload(self):
        deep = {}
        node = deep
        for _ in range(40):
            node['next'] = {}
            node = node['next']
        node['leaf'] = 'bottom'
        self.assertIn('max depth', json.dumps(agent._summarize_state_for_log(deep)))


class TestLogStructuredEmitsASummary(unittest.TestCase):
    """The sink, end to end — what actually reaches stderr and the journal."""

    def _emit(self, payload):
        buf = io.StringIO()
        with redirect_stderr(buf):
            agent.log_structured('SYNC_PARTIAL', payload)
        return buf.getvalue().strip()

    def test_the_emitted_line_is_a_summary_not_the_state(self):
        payload = _containers_payload(24)
        emitted = self._emit(payload)
        self.assertLess(len(emitted), len(json.dumps(payload)) * 0.05)
        parsed = json.loads(emitted)
        self.assertEqual(parsed['event'], 'SYNC_PARTIAL')
        self.assertEqual(parsed['payload']['containers']['count'], 24)
        self.assertNotIn('org.opencontainers.image', emitted)

    def test_files_stay_intact_so_the_leak_probe_still_has_something_to_judge(self):
        # scripts/check-journal-redaction.ts walks payload.files.<path>.content
        # and fails when a unit body sits where a size marker belongs (#2603).
        # Summarising `files` away would leave it nothing to assert on.
        path = '/home/x/.config/containers/systemd/vaultwarden.kube'
        emitted = self._emit({'files': {path: {'path': path, 'content': FAKE_QUADLET, 'modified': 1.0}}})
        parsed = json.loads(emitted)
        self.assertEqual(list(parsed['payload']['files'].keys()), [path])
        self.assertEqual(
            parsed['payload']['files'][path]['content'],
            '<%d chars redacted>' % len(FAKE_QUADLET),
        )
        self.assertNotIn(FAKE_SECRET, emitted)

    def test_a_mixed_payload_still_renders_one_parseable_line(self):
        path = '/home/x/.config/containers/systemd/vaultwarden.kube'
        payload = dict(_containers_payload(24))
        payload['files'] = {path: {'content': FAKE_QUADLET}}
        emitted = self._emit(payload)
        self.assertEqual(len(emitted.splitlines()), 1)
        parsed = json.loads(emitted)
        self.assertEqual(parsed['payload']['containers']['count'], 24)
        self.assertNotIn(FAKE_SECRET, emitted)


if __name__ == '__main__':
    unittest.main()
