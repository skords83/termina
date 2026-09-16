import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy.sh'
FAKE_DOCKER = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['DOCKER_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] == 'ps':
    print('existing-container')
elif args[0] == 'inspect' and '--format' in args:
    fmt = args[args.index('--format') + 1]
    if '.Mounts' in fmt:
        print(os.environ['HOST_ROOT'] + '\\t/dockhand')
    elif 'working_dir' in fmt:
        print(os.environ['WORKING_DIR'])
    elif 'config_files' in fmt:
        print(os.environ['WORKING_DIR'] + '/compose.yaml')
    else:
        print('existing-termina-project')
elif args[0] == 'compose' and 'pull' in args and os.environ.get('FAIL_PULL'):
    sys.exit(1)
'''


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'stacks' / 'Termina family'
        self.directory.mkdir(parents=True)
        (self.directory / 'compose.yaml').write_text('services: {}\n')
        docker = self.root / 'docker'
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.log = self.root / 'docker.log'
        self.env = {**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH'],
                    'HOST_ROOT': str(self.root), 'WORKING_DIR': '/dockhand/stacks/Termina family',
                    'DOCKER_LOG': str(self.log), 'TERMINA_DEPLOY_DIR': ''}

    def run_deploy(self):
        result = subprocess.run(['bash', str(SCRIPT)], env=self.env, text=True, capture_output=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, [args for args in calls if args[0] == 'compose']

    def test_translates_dockhand_mount_and_preserves_project(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        for args in calls:
            self.assertEqual(args[args.index('--project-name') + 1], 'existing-termina-project')
            self.assertEqual(args[args.index('--project-directory') + 1], str(self.directory))
            self.assertEqual(args[args.index('-f') + 1], str(self.directory / 'compose.yaml'))
        self.assertIn('--wait', calls[-1])

    def test_direct_host_path(self):
        self.env['WORKING_DIR'] = str(self.directory)
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)

    def test_explicit_override(self):
        self.env['WORKING_DIR'] = '/no-longer-existing/stack'
        self.env['TERMINA_DEPLOY_DIR'] = str(self.directory)
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)

    def test_missing_directory_never_runs_compose(self):
        self.env['WORKING_DIR'] = '/missing/stack'
        result, calls = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_failed_pull_never_recreates_containers(self):
        self.env['FAIL_PULL'] = '1'
        result, calls = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up' in args for args in calls))
