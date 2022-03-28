const cp = require('child_process');

const DEFAULT_TIMEOUT = 30;

class IpCommand {
  constructor(options = {}) {
    const ip = this;
    ip.options = options;

    options.paths = options.paths || {};

    if (!options.logger) {
      options.logger = console;
      console.verbose = console.debug;
    }

    if (!options.paths.ip) {
      options.paths.ip = 'ip';
    }

    if (!options.paths.sudo) {
      options.paths.sudo = '/usr/bin/sudo';
    }

    if (!options.paths.chroot) {
      options.paths.chroot = '/usr/sbin/chroot';
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn
      };
    }
  }

  async tableExists(table) {
    const ip = this;
    let result;

    try {
      result = await ip.exec(['route', 'show', 'table', table]);
    } catch (e) {
      result = e;
    }

    /**
     * 0 = exists
     * 2 = exists, but no entries
     */
    if ([0, 2].includes(result.code)) {
      return true;
    }

    return false;
  }

  async clearRulesByTable(table) {
    const ip = this;

    let rules = await ip.exec(['rule', 'show', 'table', table]);
    rules = rules.parsed;
    for (const rule of rules) {
      if (rule.priority && rule.table == table) {
        await ip.deleteRuleByPriority(rule.priority);
      }
    }
  }

  async deleteRuleByPriority(priority) {
    const ip = this;
    await ip.exec(['rule', 'del', 'priority', priority]);
  }

  async getRulesByProperties(properties = {}) {
    const ip = this;

    let rules = await ip.exec(['rule', 'show']);
    rules = rules.parsed;

    const matches = [];
    for (const rule of rules) {
      let match = true;
      for (const property in properties) {
        // TODO: make this work with ipv6
        if (property == 'srclen' && !rule.srclen) {
          rule.srclen = 32;
        }
        if (String(properties[property]) != String(rule[property])) {
          match = false;
          break;
        }
      }

      if (match) {
        matches.push(rule);
      }
    }

    return matches;
  }

  exec(args, options = {}) {
    if (!options.hasOwnProperty('timeout')) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const ip = this;
    let command = ip.options.paths.ip;
    args = args || [];
    args.unshift('-j');
    args.unshift('-d');

    let stdout = '';
    let stderr = '';

    if (ip.options.sudo) {
      args.unshift(command);
      command = ip.options.paths.sudo;
    }

    ip.options.logger.verbose("executing ip command: %s", `${command} ${args.join(" ")}`);
    const child = ip.options.executor.spawn(command, args, options);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', function (data) {
        stdout = stdout + data;
      });

      child.stderr.on('data', function (data) {
        stderr = stderr + data;
      });

      child.on('close', function (code) {
        const result = { code, stdout, stderr, timeout: false };

        ip.options.logger.verbose("ip command result:", result);
        // timeout scenario
        if (code === null) {
          result.timeout = true;
          reject(result);
        }

        try {
          result.parsed = JSON.parse(result.stdout);
        } catch (e) {
          // move along
        }

        if (code) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports.IpCommand = IpCommand;
