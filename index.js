const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const yaml = require("js-yaml");
const Mustache = require("mustache");

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const fileExists = util.promisify(fs.exists);
const required = { required: true };

/**
 * Status marks the deployment status. Only activates if token is set as an
 * input to the job.
 *
 * @param {string} state
 */
async function status(state) {
  try {
    const context = github.context;
    const deployment = context.payload.deployment;
    const token = core.getInput("token");
    if (!token || !deployment) {
      core.debug("not setting deployment status");
      return;
    }

    const client = new github.GitHub(token);
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}/checks`;

    await client.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: deployment.id,
      state,
      log_url: url,
      target_url: url,
      headers: {
        accept: 'application/vnd.github.ant-man-preview+json'
      }
    });
  } catch (error) {
    core.warning(`Failed to set deployment status: ${error.message}`);
  }
}

function releaseName(name, track) {
  if (track !== "stable") {
    return `${name}-${track}`;
  }
  return name;
}

function chartName(name) {
  if (name === "app") {
    return "/usr/src/charts/app";
  }
  return name;
}

function getValues(values) {
  if (!values) {
    return "{}";
  }
  if (typeof values === "object") {
    return JSON.stringify(values);
  }
  return values;
}

function getSecrets(secrets) {
  if (typeof secrets === "string") {
    try {
      return JSON.parse(secrets);
    } catch (err) {
      return secrets;
    }
  }
  return secrets;
}

function getValueFiles(files) {
  let fileList;
  if (typeof files === "string") {
    try {
      fileList = JSON.parse(files);
    } catch (err) {
      // Assume it's a single string.
      fileList = [files];
    }
  } else {
    fileList = files;
  }
  if (!Array.isArray(fileList)) {
    return [];
  }
  return fileList.filter(f => !!f);
}

function getInput(name, options) {
  const context = github.context;
  const deployment = context.payload.deployment;
  let val = core.getInput(name, {
    ...options,
    required: false
  });
  // Make sure that INPUT_ also works because env variables with - is not valid.
  if (val.length === 0 && name.includes('-')) {
    val = core.getInput(name.replace('-', '_'), {
      ...options,
      required: false
    });
  }
  if (deployment) {
    if (deployment[name]) val = deployment[name];
    if (deployment.payload[name]) val = deployment.payload[name];
  }
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return val;
}

/**
 * Render files renders data into the list of provided files.
 * @param {Array<string>} files
 * @param {any} data
 */
function renderFiles(files, data) {
  core.debug(
    `rendering value files [${files.join(",")}] with: ${JSON.stringify(data)}`
  );
  const tags = ["${{", "}}"];
  const promises = files.map(async file => {
    const content = await readFile(file, { encoding: "utf8" });
    const rendered = Mustache.render(content, data, {}, tags);
    await writeFile(file, rendered);
  });
  return Promise.all(promises);
}

/**
 * Makes a delete command for compatibility between helm 2 and 3.
 *
 * @param {string} helm
 * @param {string} namespace
 * @param {string} release
 */
function deleteCmd(helm, namespace, release) {
  if (helm === "helm3") {
    return ["delete", "-n", namespace, release];
  }
  return ["delete", "--purge", release];
}

/**
 * Takes in a secret value and decodes it from base64.
 *
 * @param {string} secretVal
 */
function parseBase64(secretVal) {
  return Buffer.from(secretVal, 'base64').toString('utf-8');
}

/**
 * Create a rewritten kubeconfig file that includes a hardwired authentication token.
 * @param {string} kubeconfigPath
 * @param {string} kubeToken
 */
async function addTokenToKubeConfig(kubeconfigPath, kubeToken) {
  if (!kubeconfigPath) {
    kubeconfigPath = path.join(os.homedir(), ".kube", "config");
  }
  if (!await fileExists(kubeconfigPath)) {
    throw new Error("Cannot find a kubeconfig file, which is required when using helm2 with the kube-token option");
  }

  // Read the kubeconfig file.
  const kubeconfigData = await readFile(kubeconfigPath, { encoding: "utf8" });
  const kubeconfigContent = yaml.load(kubeconfigData, {
    filename: kubeconfigPath
  });

  // Create a user with the specified token.
  const userName = "helm-deploy-action-token-user";
  if (!kubeconfigContent.users) {
    kubeconfigContent.users = [];
  }
  kubeconfigContent.users.push({
    name: userName,
    user: {
      token: kubeToken
    }
  });

  // Hook up that user to each context.
  if (!kubeconfigContent.contexts) {
    throw new Error("Cannot find contexts in the kubeconfig file, which are required when using helm2 with the kube-token option");
  }
  for (const context of kubeconfigContent.contexts) {
    context.context.user = userName;
  }

  // Write it to a local temp file.
  const newKubeconfigYaml = yaml.dump(kubeconfigContent);
  const newKubeconfigPath = "./kubeconfig-with-token.yml";
  await writeFile(newKubeconfigPath, newKubeconfigYaml);
  return newKubeconfigPath;
}

/**
 * Run executes the helm deployment.
 */
async function run() {
  try {
    const context = github.context;
    await status("pending");

    const track = getInput("track") || "stable";
    const appName = getInput("release", required);
    const release = releaseName(appName, track);
    const namespace = getInput("namespace", required);
    const chart = chartName(getInput("chart", required));
    const chartVersion = getInput("chart-version");
    const values = getValues(getInput("values"));
    const task = getInput("task");
    const version = getInput("version");
    const valueFiles = getValueFiles(getInput("value-files"));
    const removeCanary = getInput("remove-canary");
    const helm = getInput("helm") || "helm";
    const timeout = getInput("timeout");
    const repository = getInput("repository");
    const repository_password = getInput("repository-password");
    const repository_username = getInput("repository-username");
    const repository_alias = getInput("repository-alias");
    const dryRun = core.getInput("dry-run");
    const secrets = getSecrets(core.getInput("secrets"));
    const kubeContext = getInput("kube-context");
    const kubeToken = getInput("kube-token");

    core.debug(`param: helm = "${helm}"`);
    core.debug(`param: track = "${track}"`);
    core.debug(`param: release = "${release}"`);
    core.debug(`param: appName = "${appName}"`);
    core.debug(`param: namespace = "${namespace}"`);
    core.debug(`param: chart = "${chart}"`);
    core.debug(`param: chart_version = "${chartVersion}"`);
    core.debug(`param: values = "${values}"`);
    core.debug(`param: dryRun = "${dryRun}"`);
    core.debug(`param: task = "${task}"`);
    core.debug(`param: version = "${version}"`);
    core.debug(`param: secrets = "${JSON.stringify(secrets)}"`);
    core.debug(`param: valueFiles = "${JSON.stringify(valueFiles)}"`);
    core.debug(`param: removeCanary = ${removeCanary}`);
    core.debug(`param: timeout = "${timeout}"`);
    core.debug(`param: repository = "${repository}"`);
    core.debug(`param: repository_password = "${repository_password}"`);
    core.debug(`param: repository_username = "${repository_username}"`);
    core.debug(`param: repository_alias = "${repository_alias}"`);
    core.debug(`param: kube-context = "${kubeContext}"`);
    core.debug(`param: kube-token = "${kubeToken}"`);


    // Setup command options and arguments.
    const args = [
      "upgrade",
      release,
      chart,
      "--install",
      "--wait",
      "--atomic",
      `--namespace=${namespace}`,
    ];

    // Per https://helm.sh/docs/faq/#xdg-base-directory-support
    if (helm === "helm3") {
      process.env.XDG_DATA_HOME = "/root/.helm/"
      process.env.XDG_CACHE_HOME = "/root/.helm/"
      process.env.XDG_CONFIG_HOME = "/root/.helm/"
    } else {
      process.env.HELM_HOME = "/root/.helm/"
    }

    if (dryRun) args.push("--dry-run");
    if (appName) args.push(`--set=app.name=${appName}`);
    if (version) args.push(`--set=app.version=${version}`);
    if (chartVersion) args.push(`--version=${chartVersion}`);
    if (timeout) args.push(`--timeout=${timeout}`);
    valueFiles.forEach(f => args.push(`--values=${f}`));
    args.push("--values=./values.yml");

    // Special behaviour is triggered if the track is labelled 'canary'. The
    // service and ingress resources are disabled. Access to the canary
    // deployments can be routed via the main stable service resource.
    if (track === "canary") {
      args.push("--set=service.enabled=false", "--set=ingress.enabled=false");
    }

    // Setup necessary files.
    if (process.env.KUBECONFIG_FILE) {
      process.env.KUBECONFIG = "./kubeconfig.yml";
      await writeFile(process.env.KUBECONFIG, process.env.KUBECONFIG_FILE);
    } else if (process.env.KUBECONFIG_BASE64) {
      process.env.KUBECONFIG = "./kubeconfig.yml";
      await writeFile(process.env.KUBECONFIG, parseBase64(process.env.KUBECONFIG_BASE64));
    }
    await writeFile("./values.yml", values);

    if (kubeContext) args.push(`--kube-context=${kubeContext}`);

    if (kubeToken) {
      if (helm === "helm3") {
        args.push(`--kube-token=${kubeToken}`);
      } else {
        // Helm 2 does not support the --kube-token option.
        // So we rewrite the KUBECONFIG file to include the token in there.
        process.env.KUBECONFIG = await addTokenToKubeConfig(process.env.KUBECONFIG, kubeToken);
      }
    }

    core.debug(`env: KUBECONFIG="${process.env.KUBECONFIG}"`);

    if (repository && repository_alias) {
      core.info('Add repository');
      const addRepoArgs = [
        'repo',
        'add',
      ]

      if (repository_username && repository_password) {
        addRepoArgs.push(`--username`, repository_username, `--password`, repository_password);
      }

      addRepoArgs.push(repository_alias, repository,)

      await exec.exec(helm, addRepoArgs);

      const updateRepoArgs = [
        'repo',
        'update'
      ]

      core.info('Update repository');
      await exec.exec(helm, updateRepoArgs);
    }

    // Render value files using github variables.
    await renderFiles(valueFiles.concat(["./values.yml"]), {
      secrets,
      deployment: context.payload.deployment,
    });

    // Remove the canary deployment before continuing.
    if (removeCanary) {
      core.info('Remove canary helm chart');
      core.debug(`removing canary ${appName}-canary`);
      await exec.exec(helm, deleteCmd(helm, namespace, `${appName}-canary`), {
        ignoreReturnCode: true
      });
    }

    // Actually execute the deployment here.
    if (task === "remove") {
      core.info('Remove helm chart');
      await exec.exec(helm, deleteCmd(helm, namespace, release), {
        ignoreReturnCode: true
      });
    } else {
      core.info('Install helm chart');
      await exec.exec(helm, args);
    }

    await status(task === "remove" ? "inactive" : "success");
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
    await status("failure");
  }
}

run();
