const path = require('path')
const fs = require('fs')
const {URL} = require('url')
const {promisify} = require('util')
const Sequelize = require('sequelize')
const cheerio = require('cheerio')
const fetch = require('node-fetch')

const writeFilePromise = promisify(fs.writeFile)

const root = path.resolve(__dirname, '..', 'amazon-web-services.docset')

const db = new Sequelize('database', 'username', 'password', {
        dialect: 'sqlite',
        storage: path.resolve(root, 'Contents/Resources/docSet.dsidx')
})
const SearchIndex = db.define('searchIndex', {
    id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: Sequelize.STRING
    },
    type: {
        type: Sequelize.STRING
    },
    path: {
        type: Sequelize.STRING
    },
}, {
    freezeTableName: true,
    timestamps: false
})

const baseUrl = new URL('https://docs.aws.amazon.com/')
const documentRoot = path.resolve(root, 'Contents/Resources/Documents')
const downloadedFiles = new Set()

// override missing URLs by skipping past them
const missingUrls = {
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-codepipeline-customactiontype-artifactdetails.html":
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codepipeline-pipeline.html",

    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-opsworks-instance-ebsblockdevice.html":
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-opsworks-instance-timebasedautoscaling.html",

    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-opsworks-layer-volumeconfiguration.html":
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opsworks-stack.html",

    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ssm-association-target.html":
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-document.html"
}

// URLs which if we're redirected we want to keep the original page name
const keepOriginalPageName = new Set([
    "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/glossary.html"
])


function withImages(document) {
    return new Promise(resolve => {
        const resolver = resolve.bind({}, document)
        Promise.all(document('img').map((index, imgTag) => {
            const img = document(imgTag)
            if (!img.attr('src')) return

            const imageUrl = new URL(img.attr('src'), baseUrl.origin)
            const imageFilename = path.basename(imageUrl.pathname)
            const imagePath = path.resolve(documentRoot, 'img', imageFilename)

            img.attr('src', `${path.relative(path.dirname(this.url.pathname), path.dirname(imageUrl.pathname)).replace(path.dirname(img.attr('src')), '')}${imagePath.replace(documentRoot, '')}`)
            if (downloadedFiles.has(imagePath)) return

            return fetch(imageUrl.toString())
                .then(res => res.arrayBuffer())
                .then(res => writeFilePromise(imagePath, new Buffer(res)))
                .then(_ => downloadedFiles.add(imagePath))
                .catch(console.error)
        }).get()).then(resolver).catch(console.error)
    })
}

function withStylesheets(document) {
    return new Promise(resolve => {
        const resolver = resolve.bind({}, document)
        Promise.all(document('link[rel="stylesheet"]').map((index, linkTag) => {
            const link = document(linkTag)
            if (!link.attr('href')) return

            const linkUrl = new URL(link.attr('href'), baseUrl.origin)
            const linkFilename = path.basename(linkUrl.pathname)
            const linkPath = path.resolve(documentRoot, 'css', linkFilename)

            link.attr('href', `${path.relative(path.dirname(this.url.pathname), path.dirname(linkUrl.pathname)).replace(path.dirname(link.attr('href')), '')}${linkPath.replace(documentRoot, '')}`)
            if (downloadedFiles.has(linkPath)) return

            return fetch(linkUrl.toString())
                .then(res => res.arrayBuffer())
                .then(res => writeFilePromise(linkPath, new Buffer(res)))
                .then(_ => downloadedFiles.add(linkPath))
                .catch(console.error)
        }).get()).then(resolver).catch(console.error)
    })
}

const withRelativeLinks = document => new Promise(resolve => {
    document('a').each((index, aTag) => {
        const a = document(aTag)
        if (a.attr('href')) a.attr('href', a.attr('href').replace(baseUrl.href, './'))
        if (a.attr('href')) a.attr('href', a.attr('href').replace(baseUrl.href.replace('https', 'http'), './'))
    })
    resolve(document)
})

const withoutNavigation = document => new Promise(resolve => {
    document('#left-column').remove()
    document('#aws-nav').remove()
    document('#footer').remove()
    resolve(document)
})

const docSet = new Array()
const downloadDocPage = (service, section, page) => {
    let fullUrl = new URL(`${baseUrl.href}${service}/latest/${section}/${page}`)
    if (missingUrls.hasOwnProperty(fullUrl.href)) {
        fullUrl = new URL(missingUrls[fullUrl.href])
    }
    console.log(` - Fetching ${fullUrl.href}`)
    // console.log(`   service:"${service}" section:"${section}" page:"${page}"`)
    return fetch(fullUrl.href)
        .then(res => {
            // handle redirects which change the page name
            if (res.url !== fullUrl.href) {
                console.log(`   Redirect ${res.url}`)
                if (keepOriginalPageName.has(fullUrl.href)) {
                    fullUrl = new URL(res.url)
                } else {
                    fullUrl = new URL(res.url)
                    const path_parts = fullUrl.pathname.split("/")
                    if (path_parts.length != 5) {
                        throw new Error("Unexpected redirect")
                    }
                    page = path_parts[path_parts.length - 1]
                    if (!page) {
                        throw new Error("Unexpected redirect")
                    }
                    // ensure only the page has changed during the redirect
                    const expectedUrl = new URL(`${baseUrl.href}${service}/latest/${section}/${page}`)
                    if (fullUrl.href !== expectedUrl.href) {
                        throw new Error("Unexpected redirect")
                    }
                }
            }
            return res
        })
        .then(res => res.text())
        .then(cheerio.load)
        .then(withoutNavigation)
        .then(withRelativeLinks)
        .then(withImages.bind({url: fullUrl}))
        .then(withStylesheets.bind({url: fullUrl}))
        .then(document => {
            const title = document('title').text().replace(/[\n\r]+/g, '').replace(/\t/g, ' ').replace(/(\s\s+)/g, ' ').trim()
            console.log(`   Saving "${title} (${page})"`)

            const documentPath = path.resolve(documentRoot, service, 'latest', section, page)

            const segmentedDocumentPath = path.relative(process.cwd(), path.dirname(documentPath)).split('/')
            for (let i = 1; i <= segmentedDocumentPath.length; i++) {
                const segment = segmentedDocumentPath.slice(0, i).join('/')
                if (!fs.existsSync(segment)) fs.mkdirSync(segment)
            }

            return writeFilePromise(documentPath, document.root().html())
                .then(_ => {
                    docSet.push({
                        name: title,
                        type: 'Guide',
                        path: documentPath.replace(documentRoot, '')
                    })
                })
                .then(doc => {
                    let nextPage = document('link[rel="next"]').attr('href')
                    if (nextPage) {
                        return downloadDocPage(service, section, nextPage)
                    }
                    nextPage = document('a.awstoc[accesskey="n"]').attr('href')
                    return (nextPage) ? downloadDocPage(service, section, nextPage) : doc
                })
        })
}

        Promise.all([
            // CloudFormation
            downloadDocPage('AWSCloudFormation', 'APIReference', 'Welcome.html'),
            downloadDocPage('AWSCloudFormation', 'UserGuide', 'Welcome.html'),

            // S3
            downloadDocPage('AmazonS3', 'gsg', 'GetStartedWithS3.html'),
            downloadDocPage('AmazonS3', 'dev', 'Welcome.html'),

            // EC2
            downloadDocPage('AWSEC2', 'UserGuide', 'concepts.html'),

            // Lambda
            downloadDocPage('lambda', 'dg', 'welcome.html'),

            // API Gateway
            downloadDocPage('apigateway', 'developerguide', 'welcome.html'),

            // CloudFront
            downloadDocPage('AmazonCloudFront', 'DeveloperGuide', 'Introduction.html')

        ])
        .then(_ => SearchIndex.sync({ force: true }))
        .then(_ => SearchIndex.bulkCreate(docSet))
        .catch(console.error)